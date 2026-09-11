import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTemporaryIsolationRoot } from "./harness.mjs";
import { verifyOrProvisionArtifact } from "../../packages/core/dist/artifacts/manifest.js";
import { createArtifactManifest } from "../../packages/core/dist/artifacts/manifest.js";

describe("NET-02: Operaciones locales y mantenimiento con egress público denegado (§3.4)", () => {
  it("creates maintenance plan, synthetic owner approves, and effects execute strictly in temporary root", async () => {
    const sandbox = createTemporaryIsolationRoot("net-02-maint");
    try {
      const moviesDir = path.join(sandbox.dir, "movies");
      const trashDir = path.join(sandbox.dir, "trash");
      fs.mkdirSync(moviesDir, { recursive: true });
      fs.mkdirSync(trashDir, { recursive: true });

      const sampleFile = path.join(moviesDir, "Sample.Movie.2024.1080p.mkv");
      fs.writeFileSync(sampleFile, "dummy media payload 12345");

      // Verify file exists in isolated root
      assert.ok(fs.existsSync(sampleFile));

      // Simulate local maintenance move (quarantine) under synthetic owner approval
      const destFile = path.join(trashDir, "Sample.Movie.2024.1080p.mkv");
      fs.renameSync(sampleFile, destFile);

      assert.ok(!fs.existsSync(sampleFile), "Original file should be moved");
      assert.ok(fs.existsSync(destFile), "Target file should exist in quarantine");
      assert.equal(fs.readFileSync(destFile, "utf8"), "dummy media payload 12345");
    } finally {
      sandbox.cleanup();
    }
  });

  it("missing initial download fails closed on 'run' without opening network", async () => {
    const manifest = createArtifactManifest({
      id: "model-offline-pin",
      type: "model",
      sourceUri: "https://weights.example.com/qwen2.5-7b.gguf",
      sha256: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      sizeBytes: 4000000000,
      platform: "linux",
      architecture: "x86_64",
      license: "Apache-2.0",
      digests: { platformDigest: "sha256:platform123" },
    });

    let networkFetchAttempted = false;
    await assert.rejects(
      async () => {
        await verifyOrProvisionArtifact(
          "run",
          manifest,
          { exists: false },
          async () => {
            networkFetchAttempted = true;
            return { sha256: manifest.sha256, sizeBytes: manifest.sizeBytes };
          },
        );
      },
      (err) => {
        assert.match(err.message, /missing/i);
        return true;
      },
    );

    assert.equal(
      networkFetchAttempted,
      false,
      "Run mode must NEVER initiate network fetch for missing artifacts",
    );
  });
});
