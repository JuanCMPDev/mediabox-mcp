import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { deployStack, sanitizeDeployDiagnostic } from "./orchestrate.js";
import { baseConfig } from "./config/fixtures.js";
import type { DeployConfig } from "./config/types.js";
import type { DeployEvent } from "./events/types.js";
import type {
  Deployer,
  DeployerContext,
  HealthCheck,
  PrepareImagesOptions,
  ProvisionedModel,
  UpOptions,
} from "./deployer/types.js";
import { EDGE_IMAGE, generateDockerCompose } from "./generators/docker-compose.js";
import {
  findUnpinnedImages,
  imageRefsFromCompose,
  readArtifactLock,
  type ArtifactPlatform,
} from "./artifacts/lock.js";
import { computeSha256 } from "./artifacts/manifest.js";

/** Well-formed but synthetic digest: sha256 of a label, never a real artifact. */
const digest = (label: string) => `sha256:${createHash("sha256").update(label).digest("hex")}`;

const MANIFEST_PATH = "config/ollama/models/manifests/registry.ollama.ai/library/qwen2.5/7b";
const MODEL_MANIFEST = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.docker.distribution.manifest.v2+json",
  config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: digest("config"), size: 487 },
  layers: [
    { mediaType: "application/vnd.ollama.image.model", digest: digest("weights"), size: 4683073184 },
    { mediaType: "application/vnd.ollama.image.template", digest: digest("template"), size: 1482 },
  ],
});
const MODEL_DIGEST = `sha256:${computeSha256(MODEL_MANIFEST)}`;

/** In-memory Deployer: records every call, never touches Docker or the network. */
class FakeDeployer implements Deployer {
  files = new Map<string, string>();
  calls: string[] = [];
  prepareArgs: unknown[][] = [];
  upArgs: unknown[][] = [];
  platform: ArtifactPlatform = "linux/amd64";
  failResolveFor?: string;
  provisioned: ProvisionedModel | null = { name: "qwen2.5:7b", manifestDigest: MODEL_DIGEST };
  onPrepareImages?: () => void;

  async prepareImages(...args: [DeployerContext, PrepareImagesOptions?]) {
    this.calls.push("prepareImages");
    this.prepareArgs.push(args.slice(1));
    this.onPrepareImages?.();
  }
  async up(...args: [DeployerContext, UpOptions?]) {
    this.calls.push("up");
    this.upArgs.push(args.slice(1));
  }
  async waitForHealth(_ctx: DeployerContext, check: HealthCheck) {
    this.calls.push(`health:${check.name}`);
    return false;
  }
  async readFile(_ctx: DeployerContext, relPath: string) {
    const content = this.files.get(relPath);
    if (content === undefined) throw new Error(`ENOENT: ${relPath}`);
    return content;
  }
  async writeFile(_ctx: DeployerContext, relPath: string, content: string) {
    this.calls.push(`write:${relPath}`);
    this.files.set(relPath, content);
  }
  async ensureDir() {}
  async serverPlatform() {
    this.calls.push("serverPlatform");
    return this.platform;
  }
  async resolveImage(_ctx: DeployerContext, ref: string, platform: ArtifactPlatform) {
    this.calls.push(`resolve:${ref}`);
    if (ref === this.failResolveFor) {
      throw new Error(
        "Could not resolve image: ERROR: unauthorized: https://robot:hunter2@registry.example.com/v2/token?scope=repository:x&token=abc " +
          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      );
    }
    return { indexDigest: digest(`${ref}#index`), platformDigest: digest(`${ref}@${platform}`) };
  }
  async runProvisioner() {
    this.calls.push("runProvisioner");
    if (this.provisioned) this.files.set(MANIFEST_PATH, MODEL_MANIFEST);
    return this.provisioned;
  }
}

function strictConfig(profile: "offline-library" | "local-agent-online-media" = "offline-library"): DeployConfig {
  const cfg = baseConfig();
  cfg.deployment.privacyProfile = profile;
  cfg.ai = { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" };
  return cfg;
}

async function run(config: DeployConfig, deployer: FakeDeployer, extra: { artifactPlatform?: ArtifactPlatform; generateOnly?: boolean } = {}) {
  const events: DeployEvent[] = [];
  const result = await deployStack({ config, deployer, workDir: "/srv/mediabox", onEvent: (e) => events.push(e), ...extra });
  const started = events.filter((e) => e.kind === "start").map((e) => (e as { phase: string }).phase);
  return { result, events, started };
}

const index = (calls: string[], call: string) => {
  const i = calls.indexOf(call);
  expect(i, call).toBeGreaterThan(-1);
  return i;
};

describe("deployStack — legacy (no privacy profile)", () => {
  it("keeps today's calls: no artifact phase, compose pull, plain up", async () => {
    const cfg = baseConfig();
    cfg.ai = { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" };
    const deployer = new FakeDeployer();
    const { started } = await run(cfg, deployer);

    expect(started).not.toContain("deploy:prepare-artifacts");
    expect(deployer.calls.some((c) => c === "serverPlatform" || c === "runProvisioner" || c.startsWith("resolve:"))).toBe(false);
    expect(deployer.files.has("artifacts.lock.json")).toBe(false);
    expect(deployer.files.get("docker-compose.yml")).toBe(generateDockerCompose(cfg));

    expect(deployer.prepareArgs).toEqual([[]]);
    expect(deployer.upArgs).toEqual([[], [{ recreate: true, services: ["mcp-server"] }]]);
    // Every legacy health check still runs.
    expect(deployer.calls.filter((c) => c.startsWith("health:")).sort()).toEqual(
      ["flaresolverr", "jellyfin", "mcp-server", "prowlarr", "pyload", "qbittorrent", "radarr", "sonarr"].map((n) => `health:${n}`),
    );
  });
});

describe("deployStack — strict profiles (§3.2 / §3.3)", () => {
  it("prepares artifacts after generation and before image preparation", async () => {
    const deployer = new FakeDeployer();
    const cfg = strictConfig();
    const { result, started } = await run(cfg, deployer);

    expect(started.slice(0, 7)).toEqual([
      "generate:directories",
      "generate:env",
      "generate:compose",
      "generate:qbittorrent",
      "deploy:prepare-artifacts",
      "deploy:prepare-images",
      "deploy:start",
    ]);
    expect(result.errors.filter((e) => e.phase.startsWith("deploy:"))).toEqual([]);

    const calls = deployer.calls;
    const composeWrites = calls.flatMap((c, i) => (c === "write:docker-compose.yml" ? [i] : []));
    expect(composeWrites).toHaveLength(2);
    expect(index(calls, "serverPlatform")).toBeGreaterThan(composeWrites[0]);
    expect(index(calls, `resolve:${EDGE_IMAGE}`)).toBeGreaterThan(index(calls, "serverPlatform"));
    expect(composeWrites[1]).toBeGreaterThan(index(calls, "write:artifacts.lock.json"));
    expect(index(calls, "runProvisioner")).toBeGreaterThan(composeWrites[1]);
    expect(calls.lastIndexOf("write:.env")).toBeGreaterThan(index(calls, "runProvisioner"));
    expect(index(calls, "prepareImages")).toBeGreaterThan(calls.lastIndexOf("write:.env"));
    expect(index(calls, "up")).toBeGreaterThan(index(calls, "prepareImages"));
  });

  it("writes the lock, the pinned compose and the model digest", async () => {
    const deployer = new FakeDeployer();
    const cfg = strictConfig();
    await run(cfg, deployer);

    const lock = readArtifactLock(deployer.files.get("artifacts.lock.json")!);
    expect(lock.platform).toBe("linux/amd64");
    expect(Object.keys(lock.images).sort()).toEqual(imageRefsFromCompose(generateDockerCompose(cfg)));
    expect(lock.images[EDGE_IMAGE]).toEqual({
      ref: `alpine/socat@${digest(`${EDGE_IMAGE}@linux/amd64`)}`,
      indexDigest: digest(`${EDGE_IMAGE}#index`),
      platformDigest: digest(`${EDGE_IMAGE}@linux/amd64`),
      platform: "linux/amd64",
    });
    expect(lock.models["ollama:qwen2.5:7b"]).toMatchObject({
      runtime: "ollama",
      name: "qwen2.5:7b",
      manifestDigest: MODEL_DIGEST,
      layers: [
        { mediaType: "application/vnd.docker.container.image.v1+json", digest: digest("config"), size: 487 },
        { mediaType: "application/vnd.ollama.image.model", digest: digest("weights"), size: 4683073184 },
        { mediaType: "application/vnd.ollama.image.template", digest: digest("template"), size: 1482 },
      ],
    });

    const compose = deployer.files.get("docker-compose.yml")!;
    expect(findUnpinnedImages(compose)).toEqual([]);
    expect(compose).toContain("# Images pinned by digest from artifacts.lock.json");

    const env = deployer.files.get(".env")!;
    expect(env.split("\n").filter((l) => l.startsWith("LOCAL_LLM_MODEL_DIGEST="))).toEqual([
      `LOCAL_LLM_MODEL_DIGEST=${MODEL_DIGEST}`,
    ]);
  });

  it("pulls only pinned images for run and starts with --pull never", async () => {
    const deployer = new FakeDeployer();
    await run(strictConfig(), deployer);

    const [[opts]] = deployer.prepareArgs as [[PrepareImagesOptions]];
    expect(opts.pinnedImages!.every((ref) => /@sha256:[a-f0-9]{64}$/.test(ref))).toBe(true);
    expect(opts.pinnedImages).toContain(`alpine/socat@${digest(`${EDGE_IMAGE}@linux/amd64`)}`);
    // Default backend → inference-cpu; the rocm and vulkan variants are not pulled.
    expect(opts.pinnedImages).toContain(`ollama/ollama@${digest("ollama/ollama:latest@linux/amd64")}`);
    expect(opts.pinnedImages!.some((ref) => ref.startsWith("ghcr.io/ggml-org/llama.cpp@"))).toBe(false);
    expect(opts.pinnedImages).not.toContain(`ollama/ollama@${digest("ollama/ollama:rocm@linux/amd64")}`);

    expect(deployer.upArgs).toEqual([
      [{ pull: "never" }],
      [{ recreate: true, services: ["mcp-server"], pull: "never" }],
    ]);
  });

  it("offline-library: checks from the host only what the edge publishes", async () => {
    const deployer = new FakeDeployer();
    const { events } = await run(strictConfig(), deployer);

    expect(deployer.calls.filter((c) => c.startsWith("health:")).sort()).toEqual(["health:jellyfin", "health:mcp-server"]);
    expect(events).toContainEqual({
      kind: "warn",
      phase: "deploy:health",
      message: "Not checked from the host (internal-only in offline-library): qbittorrent, pyload, sonarr, radarr, prowlarr, flaresolverr",
    });
  });

  it("local-agent-online-media: bridged services are still checked", async () => {
    const deployer = new FakeDeployer();
    await run(strictConfig("local-agent-online-media"), deployer);
    expect(deployer.calls.filter((c) => c.startsWith("health:")).length).toBe(8);
  });

  it("uses the artifactPlatform option instead of asking the deployer", async () => {
    const deployer = new FakeDeployer();
    await run(strictConfig(), deployer, { artifactPlatform: "linux/arm64" });
    expect(deployer.calls).not.toContain("serverPlatform");
    expect(readArtifactLock(deployer.files.get("artifacts.lock.json")!).platform).toBe("linux/arm64");
  });

  it("fails closed before up when an image cannot be resolved, with a sanitized error", async () => {
    const deployer = new FakeDeployer();
    deployer.failResolveFor = EDGE_IMAGE;
    const { result } = await run(strictConfig(), deployer);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].phase).toBe("deploy:prepare-artifacts");
    const message = result.errors[0].message;
    expect(message).toContain("unauthorized");
    for (const secret of ["hunter2", "robot", "token=abc", "scope=", "abcdefghijklmnopqrstuvwxyz0123456789"]) {
      expect(message).not.toContain(secret);
    }

    for (const call of ["runProvisioner", "prepareImages", "up"]) expect(deployer.calls).not.toContain(call);
    expect(deployer.files.has("artifacts.lock.json")).toBe(false);
    expect(deployer.files.get("docker-compose.yml")).toContain("# UNPINNED");
  });

  it("fails closed when the provisioner reports no digest", async () => {
    const deployer = new FakeDeployer();
    deployer.provisioned = null;
    const { result } = await run(strictConfig(), deployer);

    expect(result.errors).toEqual([
      { phase: "deploy:prepare-artifacts", message: "The model provisioner did not report a manifest digest" },
    ]);
    expect(deployer.calls).not.toContain("up");
    expect(readArtifactLock(deployer.files.get("artifacts.lock.json")!).models).toEqual({});
    expect(deployer.files.get(".env")).toMatch(/^LOCAL_LLM_MODEL_DIGEST=$/m);
  });

  it("fails closed when the manifest on disk does not match the reported digest", async () => {
    const deployer = new FakeDeployer();
    deployer.provisioned = { name: "qwen2.5:7b", manifestDigest: digest("a different manifest") };
    const { result } = await run(strictConfig(), deployer);

    expect(result.errors[0].phase).toBe("deploy:prepare-artifacts");
    expect(result.errors[0].message).toContain("hash mismatch on run");
    expect(deployer.calls).not.toContain("up");
  });

  it("fails closed when the provisioner reports another model", async () => {
    const deployer = new FakeDeployer();
    deployer.provisioned = { name: "llama3:8b", manifestDigest: MODEL_DIGEST };
    const { result } = await run(strictConfig(), deployer);
    expect(result.errors[0].message).toBe("The model provisioner reported 'llama3:8b' instead of 'qwen2.5:7b'");
    expect(deployer.calls).not.toContain("up");
  });

  it("refuses to start a compose file that was un-pinned after prepare", async () => {
    const deployer = new FakeDeployer();
    const cfg = strictConfig();
    deployer.onPrepareImages = () => deployer.files.set("docker-compose.yml", generateDockerCompose(cfg));
    const { result } = await run(cfg, deployer);

    expect(result.errors[0].phase).toBe("deploy:start");
    expect(result.errors[0].message).toContain("ERR_ARTIFACT_UNPINNED");
    expect(deployer.calls).not.toContain("up");
  });

  it("skips the provisioner when there is no local AI", async () => {
    const deployer = new FakeDeployer();
    const cfg = baseConfig();
    cfg.deployment.privacyProfile = "offline-library";
    await run(cfg, deployer);

    expect(deployer.calls).not.toContain("runProvisioner");
    expect(readArtifactLock(deployer.files.get("artifacts.lock.json")!).models).toEqual({});
    expect(deployer.files.get(".env")).not.toContain("LOCAL_LLM_MODEL_DIGEST");
    expect(deployer.upArgs[0]).toEqual([{ pull: "never" }]);
  });

  it("generateOnly writes the unpinned file and resolves nothing", async () => {
    const deployer = new FakeDeployer();
    await run(strictConfig(), deployer, { generateOnly: true });
    expect(deployer.calls.some((c) => c.startsWith("resolve:") || c === "serverPlatform")).toBe(false);
    expect(deployer.files.get("docker-compose.yml")).toContain("# UNPINNED");
  });
});

describe("sanitizeDeployDiagnostic", () => {
  it("drops credentials, query strings and tokens but keeps digests", () => {
    const d = digest("kept");
    const out = sanitizeDeployDiagnostic(
      `pull https://u:p@ghcr.io/v2/x/manifests/${d}?token=abc failed; Authorization: Basic dXNlcjpwYXNz; key ${"k".repeat(40)}`,
    );
    expect(out).toContain(`https://ghcr.io/v2/x/manifests/${d}`);
    expect(out).not.toContain("u:p@");
    expect(out).not.toContain("token=abc");
    expect(out).not.toContain("dXNlcjpwYXNz");
    expect(out).not.toContain("k".repeat(40));
  });
});
