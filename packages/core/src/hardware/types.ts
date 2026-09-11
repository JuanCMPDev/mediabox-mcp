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

export interface HardwareProfile {
  os: OsKind;
  arch: ArchKind;
  cpu: CpuInfo;
  ramBytes: number;
  gpus: GpuInfo[];
  container: ContainerInfo;
  detectedRuntimes: DetectedRuntime[];
  observedAt: string;
  probeErrors: string[];
}

export interface HardwareProbeOptions {
  force?: boolean;
  timeoutMs?: number;
  overrideBackend?: InferenceBackend;
}
