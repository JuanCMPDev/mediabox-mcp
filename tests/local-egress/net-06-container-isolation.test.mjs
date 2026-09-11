import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { generateDockerCompose } from "../../packages/core/dist/generators/docker-compose.js";
import { baseConfig } from "../../packages/core/dist/config/fixtures.js";
import { createTemporaryIsolationRoot } from "./harness.mjs";

describe("NET-06: Aislamiento de contenedores, montajes y endpoints (§3.4)", () => {
  it("docker-compose strictly excludes Docker socket, named pipes, root mounts and privileges from agent container", () => {
    for (const profile of ["offline-library", "local-agent-online-media"]) {
      const cfg = baseConfig();
      cfg.deployment.privacyProfile = profile;
      cfg.ai = { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" };

      const yaml = generateDockerCompose(cfg);
      const parsed = parse(yaml);

      const mcp = parsed.services["mcp-server"];
      assert.ok(mcp, `mcp-server must exist for profile ${profile}`);

      // 1. Privileges check
      assert.equal(mcp.privileged, undefined, "Agent container must never run with privileged: true");

      // 2. Volume inspections
      const volumeStr = JSON.stringify(mcp.volumes || []);
      assert.equal(volumeStr.includes("docker.sock"), false, "Agent container must NOT mount /var/run/docker.sock");
      assert.equal(volumeStr.includes("docker_engine"), false, "Agent container must NOT mount Docker named pipe");
      assert.equal(volumeStr.includes("DOCKER_HOST"), false, "Agent container must NOT receive DOCKER_HOST");

      // 3. Root mounts check
      for (const vol of mcp.volumes || []) {
        const [src] = vol.split(":");
        assert.notEqual(src, "/", "Agent container must not mount host root /");
        assert.notEqual(src, "C:\\", "Agent container must not mount host root C:\\");
      }

      // 4. Egress isolation check
      assert.equal(
        (mcp.networks || []).includes("mediabox-external-net"),
        false,
        "Agent container must NEVER be connected to external network",
      );

      // 5. Inference container egress isolation check
      const infCuda = parsed.services["inference-cuda"];
      if (infCuda) {
        assert.equal(
          (infCuda.networks || []).includes("mediabox-external-net"),
          false,
          "Inference container must NEVER be connected to external network",
        );
      }
    }
  });

  it("handles temporary volume paths containing spaces and Unicode correctly", () => {
    const sandbox = createTemporaryIsolationRoot("net-06-espacios y acéntos ñoño");
    try {
      const testFile = path.join(sandbox.dir, "película_2024.mkv");
      fs.writeFileSync(testFile, "test-media-data");
      assert.ok(fs.existsSync(testFile));
      assert.equal(fs.readFileSync(testFile, "utf8"), "test-media-data");
    } finally {
      sandbox.cleanup();
    }
  });

  it("verifies Desktop sidecar forwards PRIVACY_PROFILE and binds to loopback", () => {
    const sidecarRs = fs.readFileSync(
      path.resolve("packages/desktop/src-tauri/src/sidecar.rs"),
      "utf8",
    );
    assert.ok(
      sidecarRs.includes('"PRIVACY_PROFILE"'),
      "sidecar.rs must forward PRIVACY_PROFILE from stack env",
    );
    assert.ok(
      sidecarRs.includes('.env("BIND_HOST", "127.0.0.1")'),
      "sidecar.rs must bind to 127.0.0.1 loopback only",
    );
  });
});
