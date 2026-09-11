import os from "node:os";
import fs from "node:fs";
import { execa } from "execa";
import type {
  HardwareProfile,
  GpuInfo,
  GpuVendor,
  GpuBackend,
  CpuInfo,
  VulkanInfo,
  HardwareProbeOptions,
  DetectedRuntime,
  OsKind,
  ArchKind,
} from "./types.js";
import type { LocalRuntimeKind, InferenceBackend } from "@mediabox/contracts";

let cachedProfile: HardwareProfile | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes (LOC-07 / Spec 233)

/** Values INFERENCE_BACKEND accepts; anything else is reported and ignored (§3.3). */
const VALID_BACKENDS = new Set<InferenceBackend>(["cuda", "rocm", "vulkan", "sycl", "metal", "cpu"]);

// ── Pure parsers (testable without host execution) ──────────────────────────

export function parseCpuFlags(cpuinfo: string): string[] {
  const flags = new Set<string>();
  const match = cpuinfo.match(/(?:flags|Features)\s*:\s*(.*)$/m);
  if (match && match[1]) {
    const raw = match[1].toLowerCase().split(/\s+/);
    for (const f of raw) {
      if (["avx", "avx2", "avx512f", "avx512bw", "avx512cd", "neon", "fp16", "fma"].includes(f)) {
        flags.add(f);
      }
    }
  }
  return Array.from(flags);
}

export function parseWindowsGpus(cimJson: string, regJson?: string): GpuInfo[] {
  let cimEntries: any[] = [];
  try {
    const parsed = JSON.parse(cimJson);
    cimEntries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }

  let regEntries: any[] = [];
  if (regJson) {
    try {
      const parsed = JSON.parse(regJson);
      regEntries = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // ignore reg parsing failure
    }
  }

  const gpus: GpuInfo[] = [];

  for (const entry of cimEntries) {
    const name = String(entry.Name || entry.name || "").trim();
    if (!name) continue;

    let vendor: GpuVendor = "other";
    const lower = name.toLowerCase();
    if (lower.includes("nvidia") || lower.includes("geforce") || lower.includes("quadro") || lower.includes("tesla") || lower.includes("rtx") || lower.includes("gtx")) {
      vendor = "nvidia";
    } else if (lower.includes("amd") || lower.includes("radeon") || lower.includes("rx ") || lower.includes("vega")) {
      vendor = "amd";
    } else if (lower.includes("intel") || lower.includes("arc") || lower.includes("iris") || lower.includes("uhd")) {
      vendor = "intel";
    }

    const backends: GpuBackend[] = [];
    if (vendor === "nvidia") {
      backends.push("cuda", "vulkan");
    } else if (vendor === "amd") {
      // Windows AMD: RX 7000 / 6000 or ROCm supported GPUs
      if (lower.includes("7800") || lower.includes("7900") || lower.includes("7700") || lower.includes("7600") || lower.includes("gfx110")) {
        backends.push("rocm", "vulkan");
      } else {
        backends.push("vulkan");
      }
    } else if (vendor === "intel") {
      backends.push("sycl", "vulkan");
    } else {
      backends.push("vulkan");
    }

    // Try matching dedicated memory from registry qwMemorySize if available
    let vramBytes: number | undefined;
    const matchingReg = regEntries.find((r) => {
      const desc = String(r.DriverDesc || "").toLowerCase();
      return desc && (lower.includes(desc) || desc.includes(lower));
    });

    if (matchingReg && matchingReg["HardwareInformation.qwMemorySize"]) {
      const bytes = Number(matchingReg["HardwareInformation.qwMemorySize"]);
      if (Number.isFinite(bytes) && bytes > 0) {
        vramBytes = bytes;
      }
    }

    if (!vramBytes && entry.AdapterRAM) {
      const bytes = Number(entry.AdapterRAM);
      if (Number.isFinite(bytes) && bytes > 0) {
        vramBytes = bytes;
      }
    }

    gpus.push({
      vendor,
      name,
      vramBytes,
      driver: entry.DriverVersion ? String(entry.DriverVersion) : undefined,
      backends,
    });
  }

  return gpus;
}

export function parseNvidiaSmiCsv(csv: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  const lines = csv.trim().split("\n");
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 3) continue;
    const [name, memStr, driver] = parts;
    const memMatch = memStr.match(/(\d+)/);
    const vramBytes = memMatch ? parseInt(memMatch[1], 10) * 1024 * 1024 : undefined;
    gpus.push({
      vendor: "nvidia",
      name,
      vramBytes,
      driver,
      backends: ["cuda", "vulkan"],
    });
  }
  return gpus;
}

/**
 * `rocminfo` lists every HSA agent, and the CPU agents come first: taking the first
 * "Marketing Name" reports the CPU as the GPU. Only agents whose `Device Type` is
 * GPU are considered, and their VRAM comes from that agent's own memory pools.
 */
export function parseRocmInfo(text: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  // Agent blocks start at "Agent N" / "*** Agent N ***"
  const blocks = text.split(/^\*+\s*Agent\s+\d+\s*\*+\s*$/im).slice(1);
  const candidates = blocks.length > 0 ? blocks : [text];

  for (const block of candidates) {
    if (!/Device\s+Type:\s*GPU/i.test(block)) continue;

    const nameMatch =
      block.match(/Marketing Name:\s*(.+)$/m) ??
      block.match(/Product Name:\s*(.+)$/m) ??
      block.match(/Name:\s*(gfx\w+)\s*$/m);
    const name = nameMatch ? nameMatch[1].trim() : "AMD Radeon GPU (ROCm)";

    let vramBytes: number | undefined;
    const explicit = block.match(/VRAM Total Memory:\s*([\d,]+)\s*(KB|MB|GB)?/i);
    if (explicit) {
      const value = parseInt(explicit[1].replace(/,/g, ""), 10);
      const unit = (explicit[2] ?? "KB").toUpperCase();
      vramBytes = unit === "GB" ? value * 1024 ** 3 : unit === "MB" ? value * 1024 ** 2 : value * 1024;
    } else {
      // Largest COARSE GRAINED pool of this agent, in KB as rocminfo prints it.
      let maxKb = 0;
      const poolRe = /Size:\s*([\d,]+)\(0x[0-9a-f]+\)\s*KB/gi;
      let m: RegExpExecArray | null;
      while ((m = poolRe.exec(block)) !== null) {
        const kb = parseInt(m[1].replace(/,/g, ""), 10);
        if (kb > maxKb) maxKb = kb;
      }
      if (maxKb > 0) vramBytes = maxKb * 1024;
    }

    const gfx = block.match(/Name:\s*(gfx\w+)/);
    gpus.push({
      vendor: "amd",
      name: gfx && !nameMatch ? `AMD ${gfx[1]}` : name,
      vramBytes,
      driver: gfx ? gfx[1] : undefined,
      backends: ["rocm", "vulkan"],
    });
  }

  return gpus;
}

/** `rocm-smi --showproductname --showmeminfo vram` output (§3.3). */
export function parseRocmSmi(text: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  const names = new Map<number, string>();
  const vram = new Map<number, number>();

  for (const line of text.split("\n")) {
    // Card Series is the marketing name; Card Model is a PCI id and only a fallback.
    const seriesMatch = line.match(/GPU\[(\d+)\]\s*:\s*Card Series:\s*(.+)$/i);
    if (seriesMatch) {
      names.set(parseInt(seriesMatch[1], 10), seriesMatch[2].trim());
      continue;
    }
    const modelMatch = line.match(/GPU\[(\d+)\]\s*:\s*Card Model:\s*(.+)$/i);
    if (modelMatch) {
      const index = parseInt(modelMatch[1], 10);
      if (!names.has(index)) names.set(index, modelMatch[2].trim());
      continue;
    }
    const vramMatch = line.match(/GPU\[(\d+)\]\s*:\s*VRAM Total Memory \(B\)\s*:\s*(\d+)/i);
    if (vramMatch) vram.set(parseInt(vramMatch[1], 10), parseInt(vramMatch[2], 10));
  }

  for (const [index, name] of [...names.entries()].sort((a, b) => a[0] - b[0])) {
    gpus.push({ vendor: "amd", name, vramBytes: vram.get(index), backends: ["rocm", "vulkan"] });
  }
  return gpus;
}

/** `vulkaninfo --summary` device list. Absence of the tool is not an error (§3.3). */
export function parseVulkanSummary(text: string): string[] {
  const devices: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/deviceName\s*=\s*(.+)$/);
    if (match) devices.push(match[1].trim());
  }
  return devices;
}

export function parseLspci(text: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  const lines = text.trim().split("\n");
  for (const line of lines) {
    if (!/(?:VGA compatible controller|3D controller|Display controller)/i.test(line)) continue;
    // Classify on the device description only. Matching the whole line made every
    // "VGA compatible controller" an AMD card, because "compatible" contains "ati".
    const description = line.replace(/^[0-9a-f:.]+\s+[^:]+:\s+/i, "").trim();
    let vendor: GpuVendor = "other";
    const backends: GpuBackend[] = ["vulkan"];
    if (/\bnvidia\b/i.test(description)) {
      vendor = "nvidia";
      backends.unshift("cuda");
    } else if (/\b(amd|ati|radeon)\b/i.test(description)) {
      vendor = "amd";
      backends.unshift("rocm");
    } else if (/\bintel\b/i.test(description)) {
      vendor = "intel";
      backends.unshift("sycl");
    }
    const name = description;
    gpus.push({
      vendor,
      name,
      backends,
    });
  }
  return gpus;
}

export function parseMacosDisplays(jsonStr: string): GpuInfo[] {
  try {
    const parsed = JSON.parse(jsonStr);
    const displays = parsed.SPDisplaysDataType || [];
    const gpus: GpuInfo[] = [];
    for (const item of displays) {
      const name = item.sppci_model || item._name || "Apple GPU";
      const vramStr = item.spdisplays_vram || item.sppci_vram || "";
      let vramBytes: number | undefined;
      const match = vramStr.match(/(\d+)\s*(MB|GB)/i);
      if (match) {
        const val = parseInt(match[1], 10);
        vramBytes = match[2].toUpperCase() === "GB" ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
      }
      gpus.push({
        vendor: "apple",
        name,
        vramBytes,
        backends: ["metal"],
      });
    }
    return gpus;
  } catch {
    return [];
  }
}

// ── Host probe runners ──────────────────────────────────────────────────────

async function probeWindowsGpus(probeErrors: string[], timeoutMs: number): Promise<GpuInfo[]> {
  try {
    const cimPromise = execa("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion | ConvertTo-Json",
    ], { timeout: timeoutMs });

    const regPromise = execa("powershell", [
      "-NoProfile",
      "-Command",
      "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Select-Object DriverDesc, 'HardwareInformation.qwMemorySize' | ConvertTo-Json",
    ], { timeout: timeoutMs }).catch(() => ({ stdout: "[]" }));

    const [cimRes, regRes] = await Promise.all([cimPromise, regPromise]);
    return parseWindowsGpus(cimRes.stdout, regRes.stdout);
  } catch (err) {
    probeErrors.push(`Windows GPU probe failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function probeLinuxGpus(probeErrors: string[], timeoutMs: number): Promise<GpuInfo[]> {
  // 1. Try nvidia-smi
  try {
    const res = await execa("nvidia-smi", [
      "--query-gpu=name,memory.total,driver_version",
      "--format=csv,noheader",
    ], { timeout: timeoutMs });
    if (res.stdout.trim()) {
      return parseNvidiaSmiCsv(res.stdout);
    }
  } catch {
    // nvidia-smi absent or failed, continue
  }

  // 2. Try rocminfo, then rocm-smi for the product name and VRAM
  let rocmGpus: GpuInfo[] = [];
  try {
    const res = await execa("rocminfo", [], { timeout: timeoutMs });
    if (res.stdout.trim()) rocmGpus = parseRocmInfo(res.stdout);
  } catch {
    // rocminfo absent, continue
  }
  try {
    const res = await execa("rocm-smi", ["--showproductname", "--showmeminfo", "vram"], { timeout: timeoutMs });
    const smi = parseRocmSmi(res.stdout);
    if (smi.length > 0) {
      // rocm-smi knows the marketing name and exact VRAM; merge it over rocminfo.
      rocmGpus = smi.map((gpu, i) => ({ ...rocmGpus[i], ...gpu, vramBytes: gpu.vramBytes ?? rocmGpus[i]?.vramBytes }));
    }
  } catch {
    // rocm-smi absent, keep what rocminfo gave us
  }
  if (rocmGpus.length > 0) return rocmGpus;

  // 3. Fallback to lspci
  try {
    const res = await execa("lspci", ["-nn"], { timeout: timeoutMs });
    if (res.stdout.trim()) {
      return parseLspci(res.stdout);
    }
  } catch (err) {
    probeErrors.push(`Linux GPU probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return [];
}

async function probeVulkan(timeoutMs: number): Promise<VulkanInfo> {
  try {
    const res = await execa("vulkaninfo", ["--summary"], { timeout: timeoutMs });
    const devices = parseVulkanSummary(res.stdout);
    return { available: devices.length > 0, devices };
  } catch {
    // vulkaninfo is optional: its absence is not an error (§3.3)
    return { available: false, devices: [] };
  }
}

async function probeCpuFlags(osKind: OsKind, arch: ArchKind, timeoutMs: number): Promise<{ flags: string[]; source: CpuInfo["flagsSource"] }> {
  if (osKind === "linux") {
    try {
      const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
      return { flags: parseCpuFlags(cpuinfo), source: "proc-cpuinfo" };
    } catch {
      /* fall through */
    }
  }

  if (osKind === "macos") {
    try {
      const res = await execa("sysctl", ["-n", "machdep.cpu.features", "machdep.cpu.leaf7_features"], { timeout: timeoutMs });
      const text = res.stdout.toLowerCase();
      const flags: string[] = [];
      if (text.includes("avx2")) flags.push("avx2");
      if (/avx512/.test(text)) flags.push("avx512");
      if (arch === "arm64") flags.push("neon");
      if (flags.length > 0) return { flags, source: "sysctl" };
    } catch {
      /* fall through */
    }
  }

  // NEON is architectural on ARMv8, so it can be asserted; AVX2 cannot.
  if (arch === "arm64") return { flags: ["neon"], source: "arch-guarantee" };
  return { flags: [], source: "unprobed" };
}

function pickRecommendedBackend(osKind: OsKind, gpus: GpuInfo[], vulkan: VulkanInfo): InferenceBackend {
  const has = (backend: GpuBackend) => gpus.some(g => g.backends.includes(backend));
  if (has("cuda")) return "cuda";
  if (osKind === "macos" && has("metal")) return "metal";
  // ROCm is only recommended where the runtime can actually use it (Linux); elsewhere
  // Vulkan is the honest recommendation for AMD (§6.6).
  if (osKind === "linux" && has("rocm")) return "rocm";
  if (vulkan.available || has("vulkan")) return "vulkan";
  if (has("sycl")) return "sycl";
  return "cpu";
}

async function probeMacosGpus(probeErrors: string[], timeoutMs: number): Promise<GpuInfo[]> {
  try {
    const res = await execa("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: timeoutMs });
    return parseMacosDisplays(res.stdout);
  } catch (err) {
    probeErrors.push(`macOS GPU probe failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Loopback Runtime Prober ─────────────────────────────────────────────────

const KNOWN_RUNTIME_ENDPOINTS: Array<{ kind: LocalRuntimeKind; port: number; path: string }> = [
  { kind: "ollama", port: 11434, path: "/api/version" },
  { kind: "lmstudio", port: 1234, path: "/api/v0/models" },
  { kind: "llamacpp", port: 8080, path: "/props" },
  { kind: "vllm", port: 8000, path: "/v1/models" },
];

async function probeLoopbackRuntimes(timeoutMs: number): Promise<DetectedRuntime[]> {
  const detected: DetectedRuntime[] = [];

  for (const ep of KNOWN_RUNTIME_ENDPOINTS) {
    const url = `http://127.0.0.1:${ep.port}${ep.path}`;
    const baseUrl = `http://127.0.0.1:${ep.port}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 2000));
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timer);
      if (res.ok) {
        let version: string | undefined;
        try {
          const body = await res.json() as any;
          if (body?.version) version = String(body.version);
        } catch {
          // ignore body parse error
        }
        detected.push({ kind: ep.kind, baseUrl, version });
      }
    } catch {
      // port closed or timed out — expected
    }
  }

  return detected;
}

// ── Main Hardware Detection Entrypoint ──────────────────────────────────────

export async function detectHardware(options: HardwareProbeOptions = {}): Promise<HardwareProfile> {
  const now = Date.now();
  if (!options.force && cachedProfile && now - cachedAt < CACHE_TTL_MS) {
    return cachedProfile;
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  const probeErrors: string[] = [];

  const platform = process.platform;
  const osKind: OsKind = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  const arch: ArchKind = process.arch === "arm64" ? "arm64" : "x64";

  // 1. CPU & RAM
  const cpus = os.cpus();
  const { flags, source: flagsSource } = await probeCpuFlags(osKind, arch, timeoutMs);

  const cpu: CpuInfo = {
    model: cpus[0]?.model || "Unknown CPU",
    cores: cpus.length,
    flags,
    flagsSource,
  };
  const ramBytes = os.totalmem();

  // 2. GPUs
  let gpus: GpuInfo[] = [];
  if (osKind === "windows") {
    gpus = await probeWindowsGpus(probeErrors, timeoutMs);
  } else if (osKind === "linux") {
    gpus = await probeLinuxGpus(probeErrors, timeoutMs);
  } else if (osKind === "macos") {
    gpus = await probeMacosGpus(probeErrors, timeoutMs);
  }

  // 3. Container & Driver Presence
  let nvidiaToolkit = false;
  let kfd = false;
  let dri = false;
  let containerRuntime: "docker" | "none" = "none";

  if (osKind === "linux") {
    kfd = fs.existsSync("/dev/kfd");
    dri = fs.existsSync("/dev/dri");
    try {
      nvidiaToolkit = fs.existsSync("/usr/bin/nvidia-container-cli") || fs.existsSync("/usr/local/bin/nvidia-container-cli");
    } catch {
      // ignore
    }
  }

  try {
    await execa("docker", ["--version"], { timeout: 2000 });
    containerRuntime = "docker";
  } catch {
    containerRuntime = "none";
  }

  // 4. Runtimes on loopback
  const detectedRuntimes = await probeLoopbackRuntimes(timeoutMs);

  // 5. Vulkan availability (optional tool; absence is not an error)
  const vulkan = await probeVulkan(Math.min(timeoutMs, 3000));

  // 6. Backend override (INFERENCE_BACKEND env or options), validated
  const rawOverride = options.overrideBackend ?? (process.env.INFERENCE_BACKEND as InferenceBackend | undefined);
  let requestedBackend: InferenceBackend | undefined;
  if (rawOverride && rawOverride !== "auto") {
    if (VALID_BACKENDS.has(rawOverride)) {
      requestedBackend = rawOverride;
      // A forced GPU backend is moved to the front of every GPU that supports it;
      // it is never invented for hardware that does not report it.
      if (rawOverride !== "cpu") {
        for (const gpu of gpus) {
          const idx = gpu.backends.indexOf(rawOverride as GpuBackend);
          if (idx > 0) {
            gpu.backends.splice(idx, 1);
            gpu.backends.unshift(rawOverride as GpuBackend);
          } else if (idx === -1) {
            probeErrors.push(
              `INFERENCE_BACKEND=${rawOverride} was requested but GPU '${gpu.name}' does not report that backend`,
            );
          }
        }
      }
    } else {
      probeErrors.push(`INFERENCE_BACKEND='${rawOverride}' is not a valid backend and was ignored`);
    }
  }

  const recommendedBackend = requestedBackend ?? pickRecommendedBackend(osKind, gpus, vulkan);

  const profile: HardwareProfile = {
    os: osKind,
    arch,
    cpu,
    ramBytes,
    gpus,
    container: {
      runtime: containerRuntime,
      nvidiaToolkit,
      kfd,
      dri,
    },
    vulkan,
    detectedRuntimes,
    requestedBackend,
    recommendedBackend,
    observedAt: new Date().toISOString(),
    probeErrors,
  };

  cachedProfile = profile;
  cachedAt = now;
  return profile;
}

export function clearHardwareCache(): void {
  cachedProfile = null;
  cachedAt = 0;
}
