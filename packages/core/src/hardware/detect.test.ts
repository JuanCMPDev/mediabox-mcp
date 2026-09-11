/* ─── Hardware detection parsers (LOC-07) ────────────────────────────────────
 * Fixtures follow the shape the real tools print, including the details that
 * break naive parsing: rocminfo lists the CPU agent first, Windows CIM caps
 * AdapterRAM at 4 GB, and Apple Silicon reports no VRAM at all.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseWindowsGpus,
  parseNvidiaSmiCsv,
  parseRocmInfo,
  parseRocmSmi,
  parseVulkanSummary,
  parseLspci,
  parseMacosDisplays,
  parseCpuFlags,
  detectHardware,
  clearHardwareCache,
} from "./detect.js";

describe("Hardware Detection Parsers (LOC-07)", () => {
  beforeEach(() => {
    clearHardwareCache();
  });

  describe("parseWindowsGpus", () => {
    it("parses AMD Radeon RX 7800 XT with 64-bit registry memory and ROCm capability", () => {
      const cimJson = JSON.stringify([
        { Name: "AMD Radeon(TM) Graphics", AdapterRAM: 536870912, DriverVersion: "32.0.21045.5002" },
        { Name: "AMD  Radeon RX 7800 XT", AdapterRAM: 4293918720, DriverVersion: "32.0.31041.1004" },
      ]);

      const regJson = JSON.stringify([
        { DriverDesc: "AMD Radeon(TM) Graphics", "HardwareInformation.qwMemorySize": 536870912 },
        { DriverDesc: "AMD  Radeon RX 7800 XT", "HardwareInformation.qwMemorySize": 17163091968 },
      ]);

      const gpus = parseWindowsGpus(cimJson, regJson);
      expect(gpus).toHaveLength(2);

      const rx7800 = gpus.find(g => g.name.includes("7800 XT"));
      expect(rx7800).toBeDefined();
      expect(rx7800?.vendor).toBe("amd");
      // The CIM value is capped at 4 GB; the registry has the real 16 GB.
      expect(rx7800?.vramBytes).toBe(17163091968);
      expect(rx7800?.backends).toContain("rocm");
      expect(rx7800?.backends).toContain("vulkan");
      expect(rx7800?.driver).toBe("32.0.31041.1004");
    });

    it("parses NVIDIA GeForce RTX on Windows", () => {
      const cimJson = JSON.stringify([
        { Name: "NVIDIA GeForce RTX 4070 Ti SUPER", AdapterRAM: 4293918720, DriverVersion: "560.81" },
      ]);
      const regJson = JSON.stringify([
        { DriverDesc: "NVIDIA GeForce RTX 4070 Ti SUPER", "HardwareInformation.qwMemorySize": 17179869184 },
      ]);

      const gpus = parseWindowsGpus(cimJson, regJson);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].vendor).toBe("nvidia");
      expect(gpus[0].vramBytes).toBe(17179869184);
      expect(gpus[0].backends).toEqual(["cuda", "vulkan"]);
    });

    it("parses Intel Arc on Windows", () => {
      const cimJson = JSON.stringify([
        { Name: "Intel(R) Arc(TM) A770 Graphics", AdapterRAM: 4293918720, DriverVersion: "31.0.101.4952" },
      ]);
      const gpus = parseWindowsGpus(cimJson);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].vendor).toBe("intel");
      expect(gpus[0].backends).toEqual(["sycl", "vulkan"]);
    });
  });

  describe("parseNvidiaSmiCsv", () => {
    it("parses Linux nvidia-smi CSV with multiple GPUs", () => {
      const csv = [
        "NVIDIA GeForce RTX 4090, 24564 MiB, 535.129.03",
        "NVIDIA GeForce RTX 3060, 12288 MiB, 535.129.03",
      ].join("\n");

      const gpus = parseNvidiaSmiCsv(csv);
      expect(gpus).toHaveLength(2);
      expect(gpus[0]).toEqual({
        vendor: "nvidia",
        name: "NVIDIA GeForce RTX 4090",
        vramBytes: 24564 * 1024 * 1024,
        driver: "535.129.03",
        backends: ["cuda", "vulkan"],
      });
      expect(gpus[1].vramBytes).toBe(12288 * 1024 * 1024);
    });
  });

  describe("parseRocmInfo", () => {
    // Real `rocminfo` lists agent 1 as the CPU and the GPU later: taking the first
    // Marketing Name reported the CPU as the GPU, with system RAM as its VRAM.
    const rocminfo = [
      "ROCk module is loaded",
      "=====================",
      "HSA System Attributes",
      "=====================",
      "Runtime Version:         1.14",
      "==========",
      "HSA Agents",
      "==========",
      "*******",
      "Agent 1",
      "*******",
      "  Name:                    AMD Ryzen 9 7950X 16-Core Processor",
      "  Marketing Name:          AMD Ryzen 9 7950X 16-Core Processor",
      "  Device Type:             CPU",
      "  Pool Info:",
      "    Pool 1",
      "      Size:                    65498524(0x3e7a55c) KB",
      "*******",
      "Agent 2",
      "*******",
      "  Name:                    gfx1101",
      "  Marketing Name:          AMD Radeon RX 7800 XT",
      "  Device Type:             GPU",
      "  Pool Info:",
      "    Pool 1",
      "      Segment:                 GLOBAL; FLAGS: COARSE GRAINED",
      "      Size:                    16760832(0xffc000) KB",
      "*** Done ***",
    ].join("\n");

    it("reports the GPU agent, never the CPU agent", () => {
      const gpus = parseRocmInfo(rocminfo);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].vendor).toBe("amd");
      expect(gpus[0].name).toBe("AMD Radeon RX 7800 XT");
      expect(gpus[0].driver).toBe("gfx1101");
      expect(gpus[0].vramBytes).toBe(16760832 * 1024);
      expect(gpus[0].backends).toEqual(["rocm", "vulkan"]);
    });

    it("returns nothing when the host has no ROCm GPU agent", () => {
      const cpuOnly = rocminfo.slice(0, rocminfo.indexOf("Agent 2"));
      expect(parseRocmInfo(cpuOnly)).toHaveLength(0);
    });

    it("reads the explicit VRAM line when rocminfo prints one", () => {
      const withVram = [
        "*******",
        "Agent 2",
        "*******",
        "  Marketing Name:          AMD Radeon RX 7900 XTX",
        "  Device Type:             GPU",
        "  VRAM Total Memory:       25165824 KB",
      ].join("\n");
      expect(parseRocmInfo(withVram)[0].vramBytes).toBe(25165824 * 1024);
    });
  });

  describe("parseRocmSmi", () => {
    it("reads the card series and exact VRAM per GPU index", () => {
      const output = [
        "======================= ROCm System Management Interface =======================",
        "================================= Product Info ================================",
        "GPU[0]\t\t: Card Series: \t\tAMD Radeon RX 7800 XT",
        "GPU[0]\t\t: Card Model: \t\t0x747e",
        "================================ Memory Usage =================================",
        "GPU[0]\t\t: VRAM Total Memory (B): 17163091968",
        "GPU[0]\t\t: VRAM Total Used Memory (B): 1234567",
        "=========================== End of ROCm SMI Log ===============================",
      ].join("\n");

      const gpus = parseRocmSmi(output);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].name).toBe("AMD Radeon RX 7800 XT");
      expect(gpus[0].vramBytes).toBe(17163091968);
    });
  });

  describe("parseVulkanSummary", () => {
    it("lists the devices vulkaninfo reports", () => {
      const output = [
        "Devices:",
        "========",
        "GPU0:",
        "\tapiVersion         = 1.3.280",
        "\tdriverVersion      = 2.0.310",
        "\tdeviceName         = AMD Radeon RX 7800 XT",
        "GPU1:",
        "\tdeviceName         = llvmpipe (LLVM 17.0.6, 256 bits)",
      ].join("\n");

      expect(parseVulkanSummary(output)).toEqual([
        "AMD Radeon RX 7800 XT",
        "llvmpipe (LLVM 17.0.6, 256 bits)",
      ]);
    });

    it("returns an empty list when the tool is not installed or prints nothing", () => {
      expect(parseVulkanSummary("")).toEqual([]);
    });
  });

  describe("parseLspci", () => {
    it("parses lspci output identifying VGA controllers", () => {
      const lspci = [
        "00:00.0 Host bridge: Intel Corporation 11th Gen Core Processor Host Bridge/DRAM Registers (rev 01)",
        "01:00.0 VGA compatible controller: NVIDIA Corporation GA104 [GeForce RTX 3070] (rev a1)",
        "01:00.1 Audio device: NVIDIA Corporation GA104 High Definition Audio Controller (rev a1)",
      ].join("\n");

      const gpus = parseLspci(lspci);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].vendor).toBe("nvidia");
      expect(gpus[0].name).toContain("GeForce RTX 3070");
      expect(gpus[0].backends).toContain("cuda");
      expect(gpus[0].backends).toContain("vulkan");
    });

    it("classifies an Intel iGPU and an AMD discrete GPU on the same Linux host", () => {
      const lspci = [
        "00:02.0 VGA compatible controller [0300]: Intel Corporation AlderLake-S GT1 [8086:4680] (rev 0c)",
        "03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 32 [Radeon RX 7700 XT / 7800 XT] [1002:747e] (rev c8)",
      ].join("\n");

      const gpus = parseLspci(lspci);
      expect(gpus).toHaveLength(2);
      expect(gpus[0].vendor).toBe("intel");
      expect(gpus[0].backends).toContain("sycl");
      expect(gpus[1].vendor).toBe("amd");
      expect(gpus[1].backends).toContain("rocm");
    });

    it("returns nothing on a headless CPU-only host", () => {
      const lspci = [
        "00:00.0 Host bridge [0600]: Intel Corporation Device [8086:4660] (rev 01)",
        "00:1f.3 Audio device [0403]: Intel Corporation Device [8086:7ad0] (rev 11)",
      ].join("\n");
      expect(parseLspci(lspci)).toHaveLength(0);
    });
  });

  describe("parseMacosDisplays", () => {
    it("parses an Apple Silicon capture, where unified memory means no VRAM key", () => {
      const json = JSON.stringify({
        SPDisplaysDataType: [
          {
            _name: "Apple M2 Max",
            sppci_model: "Apple M2 Max",
            spdisplays_mtlgpufamilysupport: "spdisplays_metal3",
          },
        ],
      });

      const gpus = parseMacosDisplays(json);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].vendor).toBe("apple");
      expect(gpus[0].name).toBe("Apple M2 Max");
      // Unified memory: the profile's RAM figure is what sizes a model, not a VRAM guess.
      expect(gpus[0].vramBytes).toBeUndefined();
      expect(gpus[0].backends).toEqual(["metal"]);
    });

    it("parses a discrete VRAM figure when the capture has one (Intel Mac)", () => {
      const json = JSON.stringify({
        SPDisplaysDataType: [{ sppci_model: "AMD Radeon Pro 5500M", spdisplays_vram: "8 GB" }],
      });
      expect(parseMacosDisplays(json)[0].vramBytes).toBe(8 * 1024 * 1024 * 1024);
    });

    it("survives an unparseable capture", () => {
      expect(parseMacosDisplays("not json")).toEqual([]);
    });
  });

  describe("parseCpuFlags", () => {
    it("extracts relevant AVX and SIMD flags from /proc/cpuinfo", () => {
      const cpuinfo = [
        "processor\t: 0",
        "vendor_id\t: GenuineIntel",
        "cpu family\t: 6",
        "flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss ht syscall nx lm constant_tsc rep_good nopl xtopology nonstop_tsc cpuid aperfmperf pni pclmulqdq ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c rdrand fsgsbase bmi1 avx2 smep bmi2 erms invpcid rdseed adx clflushopt clwb sha_ni xsaveopt xsavec avx512f avx512bw avx512cd",
      ].join("\n");

      const flags = parseCpuFlags(cpuinfo);
      expect(flags).toContain("avx");
      expect(flags).toContain("avx2");
      expect(flags).toContain("avx512f");
      expect(flags).toContain("avx512bw");
      expect(flags).toContain("fma");
    });

    it("returns nothing for a cpuinfo without a flags line", () => {
      expect(parseCpuFlags("processor : 0")).toEqual([]);
    });
  });

  describe("detectHardware live execution", () => {
    it("detects system hardware on the current host and caches the result", async () => {
      const profile1 = await detectHardware({ timeoutMs: 3000 });
      expect(profile1.cpu.cores).toBeGreaterThan(0);
      expect(profile1.ramBytes).toBeGreaterThan(1024 * 1024 * 1024);
      expect(Array.isArray(profile1.gpus)).toBe(true);
      expect(Array.isArray(profile1.detectedRuntimes)).toBe(true);
      expect(profile1.vulkan).toHaveProperty("available");
      expect(profile1.recommendedBackend).toBeDefined();

      // Flags are either probed or empty: never assumed for a platform we cannot read.
      if (profile1.cpu.flagsSource === "unprobed") {
        expect(profile1.cpu.flags).toEqual([]);
      }

      // Caching: the second call returns the same object within the TTL.
      expect(await detectHardware()).toBe(profile1);
    });

    it("records a forced backend without inventing it for hardware that lacks it", async () => {
      clearHardwareCache();
      const forced = await detectHardware({ overrideBackend: "rocm", timeoutMs: 3000 });
      expect(forced.requestedBackend).toBe("rocm");
      expect(forced.recommendedBackend).toBe("rocm");
      for (const gpu of forced.gpus) {
        if (!gpu.backends.includes("rocm")) {
          expect(forced.probeErrors.join(" ")).toContain("does not report that backend");
        }
      }
    });

    it("ignores an invalid backend override and says so", async () => {
      clearHardwareCache();
      const invalid = await detectHardware({ overrideBackend: "quantum" as never, timeoutMs: 3000 });
      expect(invalid.requestedBackend).toBeUndefined();
      expect(invalid.probeErrors.join(" ")).toContain("not a valid backend");
    });
  });
});
