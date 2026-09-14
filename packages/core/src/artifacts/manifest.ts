import { createHash } from "node:crypto";
import type { ArtifactManifest, ArtifactType, ArtifactPlatformDigests } from "../config/types.js";

export class ArtifactError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`[artifact:${code}] ${message}`);
    this.name = "ArtifactError";
  }
}

/**
 * Strips any user credentials embedded in the URI (e.g. https://user:pass@host/path -> https://host/path).
 */
export function sanitizeSourceUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // If not a standard URL, strip basic inline user:pass pattern
    return uri.replace(/\/\/[^@/]+@/, "//");
  }
}

export interface CreateArtifactManifestParams {
  id: string;
  type: ArtifactType;
  sourceUri: string;
  sha256: string;
  sizeBytes: number;
  platform: string;
  architecture: string;
  license: string;
  resolvedAt?: string;
  digests: ArtifactPlatformDigests;
  quantization?: string;
}

/**
 * Creates a validated, immutable ArtifactManifest.
 * Tags like `qwen2.5:7b` serve to search a candidate, never as a pin (§3.2).
 */
export function createArtifactManifest(params: CreateArtifactManifestParams): ArtifactManifest {
  if (!params.id || typeof params.id !== "string") {
    throw new ArtifactError("ERR_INVALID_ID", "Artifact ID is required");
  }
  if (!params.sha256 || !/^[a-f0-9]{64}$/i.test(params.sha256)) {
    throw new ArtifactError("ERR_INVALID_SHA256", `Invalid SHA-256 digest: ${params.sha256}`);
  }
  if (!Number.isFinite(params.sizeBytes) || params.sizeBytes < 0) {
    throw new ArtifactError("ERR_INVALID_SIZE", `Invalid size in bytes: ${params.sizeBytes}`);
  }
  if (!params.digests?.platformDigest) {
    throw new ArtifactError("ERR_MISSING_PLATFORM_DIGEST", "Platform digest is required");
  }

  return {
    schemaVersion: 1,
    id: params.id,
    type: params.type,
    sourceUri: sanitizeSourceUri(params.sourceUri),
    sha256: params.sha256.toLowerCase(),
    sizeBytes: params.sizeBytes,
    platform: params.platform,
    architecture: params.architecture,
    license: params.license,
    resolvedAt: params.resolvedAt ?? new Date().toISOString(),
    digests: {
      platformDigest: params.digests.platformDigest,
      multiarchIndex: params.digests.multiarchIndex,
      weightsDigest: params.digests.weightsDigest,
      tokenizerDigest: params.digests.tokenizerDigest,
      templateDigest: params.digests.templateDigest,
    },
    quantization: params.quantization,
  };
}

export interface ArtifactFileState {
  exists: boolean;
  sha256?: string;
  sizeBytes?: number;
}

/**
 * Enforces the boundary between `prepare` and `run` (§3.2):
 * - `prepare`: can download and verify hashes with installation authorization.
 * - `run`: does NOT download, update or resolve tags. Missing, mismatched or
 *   unverifiable hashes fail closed before starting the agent.
 */
export async function verifyOrProvisionArtifact(
  mode: "prepare" | "run",
  manifest: ArtifactManifest,
  state: ArtifactFileState,
  downloadFn?: () => Promise<{ sha256: string; sizeBytes: number }>,
): Promise<{ verified: boolean; message: string }> {
  if (mode === "run") {
    if (!state.exists) {
      throw new ArtifactError(
        "ERR_ARTIFACT_MISSING_ON_RUN",
        `Artifact '${manifest.id}' is missing. Downloading or resolving tags on 'run' is strictly prohibited (§3.2).`,
      );
    }
    const actualSha = state.sha256?.toLowerCase();
    if (actualSha !== manifest.sha256) {
      throw new ArtifactError(
        "ERR_HASH_MISMATCH",
        `Artifact '${manifest.id}' hash mismatch on run: expected ${manifest.sha256}, got ${actualSha}`,
      );
    }
    if (state.sizeBytes !== undefined && state.sizeBytes !== manifest.sizeBytes) {
      throw new ArtifactError(
        "ERR_SIZE_MISMATCH",
        `Artifact '${manifest.id}' size mismatch on run: expected ${manifest.sizeBytes}, got ${state.sizeBytes}`,
      );
    }
    return { verified: true, message: `Artifact '${manifest.id}' verified for run` };
  }

  // mode === "prepare"
  if (state.exists && state.sha256?.toLowerCase() === manifest.sha256) {
    return { verified: true, message: `Artifact '${manifest.id}' already present and verified` };
  }

  if (!downloadFn) {
    throw new ArtifactError(
      "ERR_DOWNLOAD_REQUIRED",
      `Artifact '${manifest.id}' is not present or has invalid hash, but no download function was provided`,
    );
  }

  const result = await downloadFn();
  if (result.sha256.toLowerCase() !== manifest.sha256) {
    throw new ArtifactError(
      "ERR_DOWNLOADED_HASH_MISMATCH",
      `Downloaded artifact '${manifest.id}' hash ${result.sha256} does not match manifest ${manifest.sha256}`,
    );
  }

  return { verified: true, message: `Artifact '${manifest.id}' downloaded and verified successfully` };
}

export function computeSha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}
