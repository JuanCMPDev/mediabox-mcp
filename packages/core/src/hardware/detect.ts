import os from "node:os";
import fs from "node:fs";
import { execa } from "execa";
import type {
  HardwareProfile,
  GpuInfo,
  GpuVendor,
  GpuBackend,
  HardwareProbeOptions,
  DetectedRuntime,
  OsKind,
  ArchKind,
} from "./types.js";
import type { LocalRuntimeKind } from "@mediabox/contracts";

let cachedProfile: HardwareProfile | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes (LOC-07 / Spec 233)

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

export function parseRocmInfo(text: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  const nameMatch = text.match(/Marketing Name:\s*(.+)$/m) ?? text.match(/Product Name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : "AMD Radeon GPU (ROCm)";
  const vramMatch = text.match(/VRAM Total Memory:\s*(\d+)/i) ?? text.match(/Size:\s*(\d+)\s*KB/i);
  let vramBytes: number | undefined;
  if (vramMatch) {
    const val = parseInt(vramMatch[1], 10);
    vramBytes = text.toLowerCase().includes("kb") ? val * 1024 : val;
  }
  gpus.push({
    vendor: "amd",
    name,
    vramBytes,
    backends: ["rocm", "vulkan"],
  });
  return gpus;
}

export function parseLspci(text: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  const lines = text.trim().split("\n");
  for (const line of lines) {
    if (!/(?:VGA compatible controller|3D controller|Display controller)/i.test(line)) continue;
    let vendor: GpuVendor = "other";
    const backends: GpuBackend[] = ["vulkan"];
    if (/nvidia/i.test(line)) {
      vendor = "nvidia";
      backends.unshift("cuda");
    } else if (/amd|ati|radeon/i.test(line)) {
      vendor = "amd";
      backends.unshift("rocm");
    } else if (/intel/i.test(line)) {
      vendor = "intel";
      backends.unshift("sycl");
    }
    const name = line.replace(/^[0-9a-f:.]+\s+[^:]+:\s+/i, "").trim();
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

  // 2. Try rocminfo / rocm-smi
  try {
    const res = await execa("rocminfo", [], { timeout: timeoutMs });
    if (res.stdout.trim()) {
      return parseRocmInfo(res.stdout);
    }
  } catch {
    // rocminfo absent, continue
  }

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
  let flags: string[] = [];
  if (osKind === "linux") {
    try {
      const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
      flags = parseCpuFlags(cpuinfo);
    } catch {
      // ignore
    }
  } else if (arch === "x64") {
    // Standard modern x64 assumption if flags unprobed
    flags = ["avx2"];
  } else if (arch === "arm64") {
    flags = ["neon"];
  }

  const cpu = {
    model: cpus[0]?.model || "Unknown CPU",
    cores: cpus.length,
    flags,
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

  // 5. Backend override (INFERENCE_BACKEND env or options)
  const overrideBackend = options.overrideBackend || (process.env.INFERENCE_BACKEND as any);
  if (overrideBackend && overrideBackend !== "auto") {
    for (const gpu of gpus) {
      if (!gpu.backends.includes(overrideBackend)) {
        gpu.backends.unshift(overrideBackend);
      }
    }
  }

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
    detectedRuntimes,
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
