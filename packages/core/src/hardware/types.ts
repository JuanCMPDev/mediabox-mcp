import type { LocalRuntimeKind, InferenceBackend } from "@mediabox/contracts";

export type OsKind = "linux" | "windows" | "macos";
export type ArchKind = "x64" | "arm64";
export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "other";
export type GpuBackend = "cuda" | "rocm" | "vulkan" | "sycl" | "metal";

export interface GpuInfo {
  vendor: GpuVendor;
  name: string;
  vramBytes?: number;
  driver?: string;
  backends: GpuBackend[];
}

export interface CpuInfo {
  model: string;
  cores: number;
  flags: string[]; // avx2, avx512, neon, etc.
  /**
   * Where the flags came from. `unprobed` means the platform has no cheap way to
   * read them, so the list is empty rather than assumed (§3.3).
   */
  flagsSource: "proc-cpuinfo" | "sysctl" | "arch-guarantee" | "unprobed";
}

export interface ContainerInfo {
  runtime: "docker" | "none";
  nvidiaToolkit: boolean;
  kfd: boolean;
  dri: boolean;
}

export interface DetectedRuntime {
  kind: LocalRuntimeKind;
  baseUrl: string;
  version?: string;
}

export interface VulkanInfo {
  available: boolean;
  /** Device names reported by `vulkaninfo --summary`, when it exists. */
  devices: string[];
}

export interface HardwareProfile {
  os: OsKind;
  arch: ArchKind;
  cpu: CpuInfo;
  ramBytes: number;
  gpus: GpuInfo[];
  container: ContainerInfo;
  vulkan: VulkanInfo;
  detectedRuntimes: DetectedRuntime[];
  /** Backend the owner forced with INFERENCE_BACKEND, after validation. */
  requestedBackend?: InferenceBackend;
  /** Backend the profile recommends for this hardware. */
  recommendedBackend: InferenceBackend;
  observedAt: string;
  probeErrors: string[];
}

export interface HardwareProbeOptions {
  force?: boolean;
  timeoutMs?: number;
  overrideBackend?: InferenceBackend;
}
