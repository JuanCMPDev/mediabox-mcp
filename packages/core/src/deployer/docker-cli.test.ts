import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DeployEvent } from "../events/types.js";

const execaMock = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: execaMock }));

import {
  DockerCliDeployer,
  SERVER_PLATFORM_ARGS,
  composeUpArgs,
  imagetoolsInspectArgs,
  provisionerProgress,
  provisionerRunArgs,
  resolveDeployPath,
} from "./docker-cli.js";

/** Well-formed but synthetic digest: sha256 of a label, never a real artifact. */
const digest = (label: string) => `sha256:${createHash("sha256").update(label).digest("hex")}`;

const SOCAT_FIXTURE = readFileSync(
  fileURLToPath(new URL("../artifacts/__fixtures__/imagetools-alpine-socat-1.8.0.3-2026-09-11.json", import.meta.url)),
  "utf8",
);

function context() {
  const events: DeployEvent[] = [];
  return { ctx: { workDir: "/srv/mediabox", onEvent: (e: DeployEvent) => events.push(e) }, events };
}

/** Minimal stand-in for an execa subprocess: a promise with an `all` stream. */
function fakeSubprocess(chunks: string[], outcome: { stdout?: string; stderr?: string; fail?: boolean }) {
  const all = new EventEmitter();
  const promise = new Promise((resolve, reject) => {
    setImmediate(() => {
      for (const chunk of chunks) all.emit("data", Buffer.from(chunk));
      if (outcome.fail) reject(Object.assign(new Error("Command failed with exit code 1"), outcome));
      else resolve({ stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" });
    });
  });
  return Object.assign(promise, { all });
}

beforeEach(() => {
  execaMock.mockReset();
});

describe("resolveDeployPath", () => {
  it("anchors relative paths inside the stack workdir", () => {
    expect(resolveDeployPath("/srv/mediabox", "config/jellyfin")).toBe(
      path.join("/srv/mediabox", "config/jellyfin"),
    );
  });

  it("preserves absolute POSIX paths", () => {
    expect(resolveDeployPath("/srv/mediabox", "/mnt/media/movies")).toBe(
      "/mnt/media/movies",
    );
  });

  it("preserves platform-absolute paths", () => {
    const absolute = path.resolve("media", "movies");
    expect(resolveDeployPath("/srv/mediabox", absolute)).toBe(absolute);
  });
});

describe("Docker CLI argument construction", () => {
  it("keeps the legacy up arguments and adds --pull never only when asked", () => {
    expect(composeUpArgs()).toEqual(["compose", "up", "-d", "--no-build"]);
    expect(composeUpArgs({ recreate: true, services: ["mcp-server"] })).toEqual([
      "compose", "up", "-d", "--no-build", "--force-recreate", "mcp-server",
    ]);
    expect(composeUpArgs({ pull: "never", recreate: true, services: ["mcp-server"] })).toEqual([
      "compose", "up", "-d", "--no-build", "--pull", "never", "--force-recreate", "mcp-server",
    ]);
  });

  it("builds the imagetools, platform and provisioner invocations", () => {
    expect(imagetoolsInspectArgs("alpine/socat:1.8.0.3", "{{json .Manifest}}")).toEqual([
      "buildx", "imagetools", "inspect", "alpine/socat:1.8.0.3", "--format", "{{json .Manifest}}",
    ]);
    expect(SERVER_PLATFORM_ARGS).toEqual(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
    expect(provisionerRunArgs()).toEqual([
      "compose", "--profile", "provision", "run", "--rm", "-T", "--pull", "missing", "mediabox-provisioner",
    ]);
  });

  it("maps provisioner output to allow-listed progress messages only", () => {
    expect(provisionerProgress("\x1b[?25lpulling 2bada8a74506:  45% ▕███    ▏ 2.1 GB/4.7 GB")).toEqual({
      message: "Pulling model blob 2bada8a74506",
      percent: 45,
    });
    expect(provisionerProgress("pulling manifest")).toEqual({ message: "Pulling model manifest" });
    expect(provisionerProgress("verifying sha256 digest")).toEqual({ message: "Verifying model blob digests" });
    expect(provisionerProgress("success")).toEqual({ message: "Model pulled" });
    expect(provisionerProgress("time=2026 level=INFO msg=\"listening on 127.0.0.1:11434\" OLLAMA_HOST=secret")).toBeNull();
    expect(provisionerProgress("   ")).toBeNull();
  });
});

describe("DockerCliDeployer", () => {
  it("passes --pull never to compose up", async () => {
    execaMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { ctx } = context();
    await new DockerCliDeployer().up(ctx, { pull: "never" });
    expect(execaMock).toHaveBeenCalledWith(
      "docker",
      ["compose", "up", "-d", "--no-build", "--pull", "never"],
      { cwd: "/srv/mediabox", stdio: "pipe" },
    );
  });

  it("reads the Docker server platform", async () => {
    execaMock.mockResolvedValue({ stdout: "linux/amd64\n" });
    const { ctx } = context();
    await expect(new DockerCliDeployer().serverPlatform(ctx)).resolves.toBe("linux/amd64");
    expect(execaMock).toHaveBeenCalledWith("docker", SERVER_PLATFORM_ARGS, expect.anything());
  });

  it("resolves a multi-arch tag with one imagetools call", async () => {
    execaMock.mockResolvedValue({ stdout: SOCAT_FIXTURE });
    const { ctx } = context();
    const resolved = await new DockerCliDeployer().resolveImage(ctx, "alpine/socat:1.8.0.3", "linux/amd64");
    expect(resolved).toEqual({
      indexDigest: "sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e",
      platformDigest: "sha256:2d83bdac2858b4bcfa57d478ce53ae3c18a1147a68db4f610454a2d60e5c19bc",
    });
    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock.mock.calls[0][1]).toEqual(imagetoolsInspectArgs("alpine/socat:1.8.0.3", "{{json .Manifest}}"));
  });

  it("checks the config platform of a single-platform manifest", async () => {
    const single = JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: digest("single"), size: 1 });
    const { ctx } = context();

    execaMock
      .mockResolvedValueOnce({ stdout: single })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ os: "linux", architecture: "amd64" }) });
    await expect(new DockerCliDeployer().resolveImage(ctx, "example/app:1", "linux/amd64")).resolves.toEqual({
      platformDigest: digest("single"),
    });
    expect(execaMock.mock.calls[1][1]).toEqual(imagetoolsInspectArgs("example/app:1", "{{json .Image}}"));

    execaMock
      .mockResolvedValueOnce({ stdout: single })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ os: "linux", architecture: "arm64" }) });
    await expect(new DockerCliDeployer().resolveImage(ctx, "example/app:1", "linux/amd64")).rejects.toThrow(
      "single-platform linux/arm64 image",
    );
  });

  it("reports a registry failure without resolving anything", async () => {
    execaMock.mockRejectedValue(Object.assign(new Error("failed"), { stderr: "ERROR: example/missing:1: not found" }));
    const { ctx } = context();
    await expect(new DockerCliDeployer().resolveImage(ctx, "example/missing:1", "linux/amd64")).rejects.toThrow(
      "Could not resolve image 'example/missing:1': ERROR: example/missing:1: not found",
    );
  });

  it("pulls pinned images one by one by digest, then builds", async () => {
    execaMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { ctx, events } = context();
    const refs = [`alpine/socat@${digest("socat")}`, `ollama/ollama@${digest("ollama")}`];
    await new DockerCliDeployer().prepareImages(ctx, { pinnedImages: refs });

    expect(execaMock.mock.calls.map((c) => c[1])).toEqual([
      ["pull", "--quiet", refs[0]],
      ["pull", "--quiet", refs[1]],
      ["compose", "build", "--progress=plain"],
    ]);
    expect(events).toContainEqual({ kind: "progress", phase: "deploy:prepare-images", message: "Pulled 2 digest-pinned images" });
  });

  it("refuses to pull a tag in pinned mode", async () => {
    execaMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { ctx } = context();
    await expect(
      new DockerCliDeployer().prepareImages(ctx, { pinnedImages: ["ollama/ollama:latest"] }),
    ).rejects.toThrow("Refusing to pull unpinned image 'ollama/ollama:latest'");
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("keeps compose pull for legacy deploys", async () => {
    execaMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { ctx } = context();
    await new DockerCliDeployer().prepareImages(ctx);
    expect(execaMock.mock.calls[0][1]).toEqual(["compose", "pull", "--quiet"]);
  });

  it("runs the provisioner, streams throttled progress and returns the reported digest", async () => {
    const reported = digest("manifest");
    execaMock.mockReturnValue(
      fakeSubprocess(
        [
          "pulling manifest\n",
          "pulling 2bada8a74506:   1% ▕  ▏\rpulling 2bada8a74506:   5% ▕  ▏\rpulling 2bada8a7",
          "4506:  50% ▕  ▏\rpulling 2bada8a74506: 100% ▕  ▏\n",
          "verifying sha256 digest\nwriting manifest\nsuccess\n",
          `MEDIABOX_MODEL_DIGEST qwen2.5:7b ${reported}\n`,
        ],
        { stdout: `pulling manifest\nsuccess\nMEDIABOX_MODEL_DIGEST qwen2.5:7b ${reported}\n` },
      ),
    );
    const { ctx, events } = context();

    await expect(new DockerCliDeployer().runProvisioner(ctx)).resolves.toEqual({
      name: "qwen2.5:7b",
      manifestDigest: reported,
    });
    expect(execaMock).toHaveBeenCalledWith("docker", provisionerRunArgs(), {
      cwd: "/srv/mediabox",
      stdio: "pipe",
      all: true,
    });
    expect(events.map((e) => (e.kind === "progress" ? [e.phase, e.message, e.percent] : e.kind))).toEqual([
      ["deploy:prepare-artifacts", "Pulling model manifest", undefined],
      ["deploy:prepare-artifacts", "Pulling model blob 2bada8a74506", 1],
      ["deploy:prepare-artifacts", "Pulling model blob 2bada8a74506", 50],
      ["deploy:prepare-artifacts", "Pulling model blob 2bada8a74506", 100],
      ["deploy:prepare-artifacts", "Verifying model blob digests", undefined],
      ["deploy:prepare-artifacts", "Writing model manifest", undefined],
      ["deploy:prepare-artifacts", "Model pulled", undefined],
      ["deploy:prepare-artifacts", "Model manifest digest reported", undefined],
    ]);
  });

  it("surfaces the provisioner's own failure marker", async () => {
    execaMock.mockReturnValue(
      fakeSubprocess([], { fail: true, stderr: "pull ok\nMEDIABOX_PROVISION_ERROR digest-not-found\n" }),
    );
    const { ctx } = context();
    await expect(new DockerCliDeployer().runProvisioner(ctx)).rejects.toThrow(
      "Model provisioning failed: digest-not-found",
    );
  });

  it("returns null when the provisioner prints no digest line", async () => {
    execaMock.mockReturnValue(fakeSubprocess([], { stdout: "success\n" }));
    const { ctx } = context();
    await expect(new DockerCliDeployer().runProvisioner(ctx)).resolves.toBeNull();
  });
});
