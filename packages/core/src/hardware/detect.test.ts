import { describe, it, expect, beforeEach } from "vitest";
import {
  parseWindowsGpus,
  parseNvidiaSmiCsv,
  parseRocmInfo,
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
        {
          Name: "AMD Radeon(TM) Graphics",
          AdapterRAM: 536870912,
          DriverVersion: "32.0.21045.5002",
        },
        {
          Name: "AMD  Radeon RX 7800 XT",
          AdapterRAM: 4293918720,
          DriverVersion: "32.0.31041.1004",
        },
      ]);

      const regJson = JSON.stringify([
        {
          DriverDesc: "AMD Radeon(TM) Graphics",
          "HardwareInformation.qwMemorySize": 536870912,
        },
        {
          DriverDesc: "AMD  Radeon RX 7800 XT",
          "HardwareInformation.qwMemorySize": 17163091968,
        },
      ]);

      const gpus = parseWindowsGpus(cimJson, regJson);
      expect(gpus).toHaveLength(2);

      const rx7800 = gpus.find((g) => g.name.includes("7800 XT"));
      expect(rx7800).toBeDefined();
      expect(rx7800?.vendor).toBe("amd");
      expect(rx7800?.vramBytes).toBe(17163091968); // Exact 16 GB from qwMemorySize
      expect(rx7800?.backends).toContain("rocm");
      expect(rx7800?.backends).toContain("vulkan");
      expect(rx7800?.driver).toBe("32.0.31041.1004");
    });

    it("parses NVIDIA GeForce RTX on Windows", () => {
      const cimJson = JSON.stringify([
        {
          Name: "NVIDIA GeForce RTX 4070 Ti SUPER",
          AdapterRAM: 4293918720,
          DriverVersion: "560.81",
        },
      ]);
      const regJson = JSON.stringify([
        {
          DriverDesc: "NVIDIA GeForce RTX 4070 Ti SUPER",
          "HardwareInformation.qwMemorySize": 17179869184,
        },
      ]);

      const gpus = parseWindowsGpus(cimJson, regJson);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].vendor).toBe("nvidia");
      expect(gpus[0].vramBytes).toBe(17179869184);
      expect(gpus[0].backends).toEqual(["cuda", "vulkan"]);
    });

    it("parses Intel Arc on Windows", () => {
      const cimJson = JSON.stringify([
        {
          Name: "Intel(R) Arc(TM) A770 Graphics",
          AdapterRAM: 4293918720,
          DriverVersion: "31.0.101.4952",
        },
      ]);
      const gpus = parseWindowsGpus(cimJson);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].vendor).toBe("intel");
      expect(gpus[0].backends).toEqual(["sycl", "vulkan"]);
    });
  });

  describe("parseNvidiaSmiCsv", () => {
    it("parses Linux nvidia-smi CSV with multiple GPUs", () => {
      const csv = `
NVIDIA GeForce RTX 4090, 24564 MiB, 535.129.03
NVIDIA GeForce RTX 3060, 12288 MiB, 535.129.03
`;
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
    it("parses rocminfo / rocm-smi output", () => {
      const output = `
======= ROCm System Management Interface =======
Product Name: AMD Radeon RX 7900 XTX
VRAM Total Memory: 25753026560
`;
      const gpus = parseRocmInfo(output);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].vendor).toBe("amd");
      expect(gpus[0].name).toBe("AMD Radeon RX 7900 XTX");
      expect(gpus[0].vramBytes).toBe(25753026560);
      expect(gpus[0].backends).toEqual(["rocm", "vulkan"]);
    });
  });

  describe("parseLspci", () => {
    it("parses lspci output identifying VGA controllers", () => {
      const lspci = `
00:00.0 Host bridge: Intel Corporation 11th Gen Core Processor Host Bridge/DRAM Registers (rev 01)
01:00.0 VGA compatible controller: NVIDIA Corporation GA104 [GeForce RTX 3070] (rev a1)
01:00.1 Audio device: NVIDIA Corporation GA104 High Definition Audio Controller (rev a1)
`;
      const gpus = parseLspci(lspci);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].vendor).toBe("nvidia");
      expect(gpus[0].name).toContain("GeForce RTX 3070");
      expect(gpus[0].backends).toContain("cuda");
      expect(gpus[0].backends).toContain("vulkan");
    });
  });

  describe("parseMacosDisplays", () => {
    it("parses Apple Silicon displays json", () => {
      const json = JSON.stringify({
        SPDisplaysDataType: [
          {
            _name: "Apple M2 Max",
            spdisplays_vram: "32 GB",
          },
        ],
      });
      const gpus = parseMacosDisplays(json);
      expect(gpus).toHaveLength(1);
      expect(gpus[0].vendor).toBe("apple");
      expect(gpus[0].name).toBe("Apple M2 Max");
      expect(gpus[0].vramBytes).toBe(32 * 1024 * 1024 * 1024);
      expect(gpus[0].backends).toEqual(["metal"]);
    });
  });

  describe("parseCpuFlags", () => {
    it("extracts relevant AVX and SIMD flags from /proc/cpuinfo", () => {
      const cpuinfo = `
processor	: 0
vendor_id	: GenuineIntel
cpu family	: 6
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss ht tm pbe syscall nx pdpe1gb rdtscp lm constant_tsc art arch_perfmon pebs bts rep_good nopl xtopology nonstop_tsc cpuid aperfmperf pni pclmulqdq dtes64 monitor ds_cpl vmx est tm2 ssse3 sdbg fma cx16 xtpr pdcm pcid sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes xsave avx f16c rdrand lahf_lm abm 3dnowprefetch cpuid_fault epb ssbd ibrs ibpb stibp ibrs_enhanced tpr_shadow flexpriority ept vpid ept_ad fsgsbase tsc_adjust bmi1 avx2 smep bmi2 erms invpcid rdseed adx smap clflushopt clwb intel_pt sha_ni xsaveopt xsavec xgetbv1 xsaves split_lock_detect user_shstk avx512f avx512bw avx512cd
`;
      const flags = parseCpuFlags(cpuinfo);
      expect(flags).toContain("avx");
      expect(flags).toContain("avx2");
      expect(flags).toContain("avx512f");
      expect(flags).toContain("avx512bw");
      expect(flags).toContain("fma");
    });
  });

  describe("detectHardware live execution", () => {
    it("detects system hardware on current host and caches result", async () => {
      const profile1 = await detectHardware({ timeoutMs: 3000 });
      expect(profile1).toHaveProperty("os");
      expect(profile1).toHaveProperty("arch");
      expect(profile1).toHaveProperty("cpu");
      expect(profile1.cpu.cores).toBeGreaterThan(0);
      expect(profile1.ramBytes).toBeGreaterThan(1024 * 1024 * 1024);
      expect(Array.isArray(profile1.gpus)).toBe(true);
      expect(Array.isArray(profile1.detectedRuntimes)).toBe(true);

      // Verify caching: second call returns identical reference
      const profile2 = await detectHardware();
      expect(profile2).toBe(profile1);

      // Clear cache and probe with override
      clearHardwareCache();
      const profile3 = await detectHardware({ overrideBackend: "rocm" });
      expect(profile3).not.toBe(profile1);
      if (profile3.gpus.length > 0) {
        expect(profile3.gpus[0].backends).toContain("rocm");
      }
    });
  });
});
