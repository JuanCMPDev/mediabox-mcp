import { describe, it, expect } from "vitest";
import {
  createArtifactManifest,
  verifyOrProvisionArtifact,
  sanitizeSourceUri,
  ArtifactError,
} from "./manifest.js";

describe("ArtifactManifest & Provisioning (P10 / §3.2)", () => {
  const validParams = {
    id: "model-qwen2.5-7b-q4",
    type: "model" as const,
    sourceUri: "https://ollama.com/library/qwen2.5:7b",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sizeBytes: 4680000000,
    platform: "linux",
    architecture: "x86_64",
    license: "Apache-2.0",
    digests: {
      platformDigest: "sha256:platform0123456789abcdef",
      weightsDigest: "sha256:weights0123456789abcdef",
      tokenizerDigest: "sha256:tok0123456789abcdef",
      templateDigest: "sha256:tmpl0123456789abcdef",
    },
    quantization: "Q4_K_M",
  };

  it("creates a valid manifest and sanitizes credentials from sourceUri", () => {
    const withCreds = {
      ...validParams,
      sourceUri: "https://user:secret123@registry.example.com/models/qwen",
    };
    const manifest = createArtifactManifest(withCreds);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.sourceUri).toBe("https://registry.example.com/models/qwen");
    expect(manifest.sha256).toBe(validParams.sha256);
    expect(manifest.digests.weightsDigest).toBe("sha256:weights0123456789abcdef");
  });

  it("rejects manifest creation with invalid sha256 or size", () => {
    expect(() =>
      createArtifactManifest({ ...validParams, sha256: "not-a-sha" }),
    ).toThrow(ArtifactError);

    expect(() =>
      createArtifactManifest({ ...validParams, sizeBytes: -1 }),
    ).toThrow(ArtifactError);
  });

  it("in run mode: fails closed if artifact does not exist (never downloads on run)", async () => {
    const manifest = createArtifactManifest(validParams);
    await expect(
      verifyOrProvisionArtifact("run", manifest, { exists: false }),
    ).rejects.toThrow("Downloading or resolving tags on 'run' is strictly prohibited");
  });

  it("in run mode: fails if hash mismatch", async () => {
    const manifest = createArtifactManifest(validParams);
    await expect(
      verifyOrProvisionArtifact("run", manifest, {
        exists: true,
        sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        sizeBytes: validParams.sizeBytes,
      }),
    ).rejects.toThrow("hash mismatch on run");
  });

  it("in run mode: succeeds if artifact exists and hash matches", async () => {
    const manifest = createArtifactManifest(validParams);
    const res = await verifyOrProvisionArtifact("run", manifest, {
      exists: true,
      sha256: validParams.sha256,
      sizeBytes: validParams.sizeBytes,
    });
    expect(res.verified).toBe(true);
  });

  it("in prepare mode: downloads and verifies hash", async () => {
    const manifest = createArtifactManifest(validParams);
    let downloaded = false;
    const res = await verifyOrProvisionArtifact(
      "prepare",
      manifest,
      { exists: false },
      async () => {
        downloaded = true;
        return { sha256: validParams.sha256, sizeBytes: validParams.sizeBytes };
      },
    );
    expect(downloaded).toBe(true);
    expect(res.verified).toBe(true);
  });

  it("in prepare mode: fails if downloaded hash does not match manifest", async () => {
    const manifest = createArtifactManifest(validParams);
    await expect(
      verifyOrProvisionArtifact(
        "prepare",
        manifest,
        { exists: false },
        async () => ({
          sha256: "badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb",
          sizeBytes: 123,
        }),
      ),
    ).rejects.toThrow("Downloaded artifact");
  });
});
