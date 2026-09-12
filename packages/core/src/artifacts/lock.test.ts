import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyArtifactLock,
  assertImageConfigPlatform,
  findUnpinnedImages,
  imageRefsFromCompose,
  imageRepository,
  lockedImage,
  normalizeOllamaModelName,
  ollamaManifestPath,
  parseDockerServerPlatform,
  parseImagetoolsManifest,
  parseOllamaManifest,
  parseProvisionerOutput,
  readArtifactLock,
  serializeArtifactLock,
  validateArtifactLock,
  verifyProvisionedModel,
  type ArtifactLock,
} from "./lock.js";
import { ArtifactError, computeSha256 } from "./manifest.js";

/** Well-formed but synthetic digest: sha256 of a label, never a real artifact. */
const digest = (label: string) => `sha256:${createHash("sha256").update(label).digest("hex")}`;
const BOM = String.fromCharCode(0xfeff);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ArtifactError ? err.code : `not-artifact:${(err as Error).message}`;
  }
  return undefined;
}

// Captured 2026-09-11 with:
//   docker buildx imagetools inspect alpine/socat:1.8.0.3 --format '{{json .Manifest}}'
const SOCAT_FIXTURE = readFileSync(
  fileURLToPath(new URL("./__fixtures__/imagetools-alpine-socat-1.8.0.3-2026-09-11.json", import.meta.url)),
  "utf8",
);

describe("parseImagetoolsManifest (§3.2)", () => {
  it("selects the platform manifest from a real Docker manifest list", () => {
    const amd64 = parseImagetoolsManifest(SOCAT_FIXTURE, "linux/amd64");
    expect(amd64).toEqual({
      kind: "index",
      indexDigest: "sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e",
      platformDigest: "sha256:2d83bdac2858b4bcfa57d478ce53ae3c18a1147a68db4f610454a2d60e5c19bc",
    });

    const arm64 = parseImagetoolsManifest(SOCAT_FIXTURE, "linux/arm64");
    expect(arm64.indexDigest).toBe(amd64.indexDigest);
    expect(arm64.platformDigest).toBe("sha256:fc6a9f04d63c655e56a7fcbcf2a23b4476ec07b22390e2d4a096a940135192cd");
  });

  it("skips BuildKit attestation entries in an OCI index", () => {
    const index = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest: digest("index"),
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: digest("attestation"),
          annotations: { "vnd.docker.reference.type": "attestation-manifest" },
          platform: { architecture: "unknown", os: "unknown" },
        },
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: digest("amd64"),
          platform: { architecture: "amd64", os: "linux" },
        },
      ],
    });
    expect(parseImagetoolsManifest(index, "linux/amd64").platformDigest).toBe(digest("amd64"));
  });

  it("prefers the baseline arm64 variant over others", () => {
    const index = JSON.stringify({
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest: digest("index"),
      manifests: [
        { digest: digest("arm64-v9"), platform: { architecture: "arm64", os: "linux", variant: "v9" } },
        { digest: digest("arm64-v8"), platform: { architecture: "arm64", os: "linux", variant: "v8" } },
      ],
    });
    expect(parseImagetoolsManifest(index, "linux/arm64").platformDigest).toBe(digest("arm64-v8"));
  });

  it("returns a single-platform manifest without an index digest", () => {
    const single = JSON.stringify({
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      digest: digest("single"),
      size: 699,
    });
    expect(parseImagetoolsManifest(single, "linux/amd64")).toEqual({ kind: "manifest", platformDigest: digest("single") });
  });

  it("strips a leading BOM", () => {
    expect(parseImagetoolsManifest(BOM + SOCAT_FIXTURE, "linux/amd64").platformDigest).toBe(
      "sha256:2d83bdac2858b4bcfa57d478ce53ae3c18a1147a68db4f610454a2d60e5c19bc",
    );
  });

  it("fails closed on a missing platform, bad digests, unknown media types and non-JSON", () => {
    const armOnly = JSON.stringify({
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest: digest("index"),
      manifests: [{ digest: digest("arm64"), platform: { architecture: "arm64", os: "linux" } }],
    });
    expect(codeOf(() => parseImagetoolsManifest(armOnly, "linux/amd64"))).toBe("ERR_PLATFORM_NOT_FOUND");
    expect(() => parseImagetoolsManifest(armOnly, "linux/amd64")).toThrow("available: linux/arm64");

    const shortDigest = JSON.stringify({
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest: "sha256:abc",
      manifests: [],
    });
    expect(codeOf(() => parseImagetoolsManifest(shortDigest, "linux/amd64"))).toBe("ERR_INVALID_DIGEST");

    const tagOnly = JSON.stringify({ mediaType: "application/vnd.docker.distribution.manifest.v2+json", digest: "latest" });
    expect(codeOf(() => parseImagetoolsManifest(tagOnly, "linux/amd64"))).toBe("ERR_INVALID_DIGEST");

    const helm = JSON.stringify({ mediaType: "application/vnd.cncf.helm.config.v1+json", digest: digest("helm") });
    expect(codeOf(() => parseImagetoolsManifest(helm, "linux/amd64"))).toBe("ERR_IMAGETOOLS_OUTPUT");

    expect(codeOf(() => parseImagetoolsManifest("ERROR: not found", "linux/amd64"))).toBe("ERR_IMAGETOOLS_OUTPUT");
  });
});

describe("platform helpers", () => {
  it("maps the Docker server platform", () => {
    expect(parseDockerServerPlatform("linux/amd64\n")).toBe("linux/amd64");
    expect(parseDockerServerPlatform("linux/aarch64")).toBe("linux/arm64");
    expect(codeOf(() => parseDockerServerPlatform("windows/amd64"))).toBe("ERR_UNSUPPORTED_PLATFORM");
  });

  it("checks a single-platform image config", () => {
    assertImageConfigPlatform(JSON.stringify({ architecture: "amd64", os: "linux" }), "linux/amd64", "x");
    expect(() =>
      assertImageConfigPlatform(JSON.stringify({ architecture: "arm64", os: "linux" }), "linux/amd64", "busybox:1"),
    ).toThrow("single-platform linux/arm64 image");
  });
});

describe("compose references", () => {
  const compose = `
services:
  a:
    image: ghcr.io/juancmpdev/mediabox-mcp:\${IMAGE_TAG:-2.2.0}
  b:
    image: lscr.io/linuxserver/jellyfin:latest
  c:
    image: lscr.io/linuxserver/jellyfin:latest
    profiles: [x]
  d:
    build: { context: . }
`;

  it("lists every image once, profiled services included, with compose defaults resolved", () => {
    expect(imageRefsFromCompose(compose)).toEqual([
      "ghcr.io/juancmpdev/mediabox-mcp:2.2.0",
      "lscr.io/linuxserver/jellyfin:latest",
    ]);
  });

  it("refuses an image that depends on an env var without a default", () => {
    expect(codeOf(() => imageRefsFromCompose({ services: { a: { image: "repo/x:${TAG}" } } }))).toBe(
      "ERR_IMAGE_REF_UNRESOLVED",
    );
  });

  it("derives the repository of a reference", () => {
    expect(imageRepository("caddy:2-alpine")).toBe("caddy");
    expect(imageRepository("lscr.io/linuxserver/jellyfin:latest")).toBe("lscr.io/linuxserver/jellyfin");
    expect(imageRepository("localhost:5000/team/app")).toBe("localhost:5000/team/app");
    expect(imageRepository("localhost:5000/team/app:1.0")).toBe("localhost:5000/team/app");
    expect(imageRepository(`busybox@${digest("x")}`)).toBe("busybox");
  });
});

function lockFor(refs: string[]): ArtifactLock {
  const lock: ArtifactLock = {
    schemaVersion: 1,
    resolvedAt: "2026-09-11T00:00:00.000Z",
    platform: "linux/amd64",
    images: {},
    models: {},
  };
  for (const ref of refs) {
    lock.images[ref] = lockedImage(ref, { indexDigest: digest(`${ref}#index`), platformDigest: digest(ref) }, "linux/amd64");
  }
  return lock;
}

describe("applyArtifactLock", () => {
  const compose = {
    networks: { n: { driver: "bridge" } },
    services: {
      web: { image: "lscr.io/linuxserver/jellyfin:latest", container_name: "jellyfin", pull_policy: "always" },
      api: { image: "ghcr.io/juancmpdev/mediabox-mcp:${IMAGE_TAG:-2.2.0}", ports: ["3000:3000"] },
      built: { build: { context: "." } },
    },
  };

  it("pins every image by platform digest with pull_policy: never, without mutating the input", () => {
    const refs = imageRefsFromCompose(compose);
    const pinned = applyArtifactLock(compose, lockFor(refs));

    expect(pinned.services.web).toEqual({
      image: `lscr.io/linuxserver/jellyfin@${digest("lscr.io/linuxserver/jellyfin:latest")}`,
      pull_policy: "never",
      container_name: "jellyfin",
    });
    expect(Object.keys(pinned.services.web)).toEqual(["image", "pull_policy", "container_name"]);
    expect(pinned.services.api.image).toBe(`ghcr.io/juancmpdev/mediabox-mcp@${digest("ghcr.io/juancmpdev/mediabox-mcp:2.2.0")}`);
    expect(pinned.services.built).toEqual({ build: { context: "." } });
    expect(findUnpinnedImages(pinned)).toEqual([]);

    expect(compose.services.web.image).toBe("lscr.io/linuxserver/jellyfin:latest");
    expect(findUnpinnedImages(compose)).toEqual(["web", "api"]);
  });

  it("throws ERR_ARTIFACT_UNPINNED naming every image without a lock entry", () => {
    const lock = lockFor(["lscr.io/linuxserver/jellyfin:latest"]);
    let error: unknown;
    try {
      applyArtifactLock(
        { services: { ...compose.services, other: { image: "caddy:2-alpine" } } },
        lock,
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ArtifactError);
    expect((error as ArtifactError).code).toBe("ERR_ARTIFACT_UNPINNED");
    expect((error as Error).message).toContain("api (ghcr.io/juancmpdev/mediabox-mcp:2.2.0)");
    expect((error as Error).message).toContain("other (caddy:2-alpine)");
  });
});

describe("validateArtifactLock", () => {
  it("accepts a well-formed lock and round-trips through JSON", () => {
    const lock = lockFor(["caddy:2-alpine"]);
    lock.models["ollama:qwen2.5:7b"] = {
      runtime: "ollama",
      name: "qwen2.5:7b",
      manifestDigest: digest("manifest"),
      layers: [{ mediaType: "application/vnd.ollama.image.model", digest: digest("weights"), size: 10 }],
      resolvedAt: "2026-09-11T00:00:00.000Z",
    };
    expect(readArtifactLock(BOM + serializeArtifactLock(lock))).toEqual(lock);
  });

  it("rejects malformed digests, foreign refs, platform drift and missing model blobs", () => {
    const lock = lockFor(["caddy:2-alpine"]) as any;
    lock.images["caddy:2-alpine"].platformDigest = "sha256:" + "A".repeat(64);
    lock.images["nginx:1"] = { ref: `evil/nginx@${digest("n")}`, platformDigest: digest("n"), platform: "linux/amd64" };
    lock.images["redis:7"] = { ref: `redis@${digest("r")}`, platformDigest: digest("r"), platform: "linux/arm64" };
    lock.models["ollama:x"] = { runtime: "ollama", name: "x", manifestDigest: "sha256:123", layers: [], resolvedAt: "later" };

    let message = "";
    try {
      validateArtifactLock(lock);
    } catch (err) {
      expect((err as ArtifactError).code).toBe("ERR_INVALID_LOCK");
      message = (err as Error).message;
    }
    expect(message).toContain("images['caddy:2-alpine'].platformDigest is not a sha256 digest");
    expect(message).toContain(`images['nginx:1'].ref must be nginx@${digest("n")}`);
    expect(message).toContain("images['redis:7'].platform must equal the lock platform");
    expect(message).toContain("models['ollama:x'].manifestDigest is not a sha256 digest");
    expect(message).toContain("models['ollama:x'].layers must list the manifest blobs");
    expect(message).toContain("models['ollama:x'].resolvedAt must be an ISO timestamp");
  });

  it("rejects an unsupported schema or platform", () => {
    expect(codeOf(() => validateArtifactLock({ ...lockFor([]), schemaVersion: 2 }))).toBe("ERR_INVALID_LOCK");
    expect(codeOf(() => validateArtifactLock({ ...lockFor([]), platform: "linux/s390x" }))).toBe("ERR_INVALID_LOCK");
    expect(codeOf(() => readArtifactLock("{"))).toBe("ERR_INVALID_LOCK");
  });
});

describe("Ollama model provisioning helpers", () => {
  it("parses the provisioner digest line and ignores noise", () => {
    const out = [
      "pulling manifest",
      "pulling 2bada8a74506: 100% ▕████████████████▏ 4.7 GB",
      "success",
      `MEDIABOX_MODEL_DIGEST qwen2.5:7b ${digest("manifest")}`,
    ].join("\r\n");
    expect(parseProvisionerOutput(out)).toEqual({ name: "qwen2.5:7b", manifestDigest: digest("manifest") });
    expect(parseProvisionerOutput("MEDIABOX_MODEL_DIGEST qwen2.5:7b sha256:abc")).toBeNull();
    expect(parseProvisionerOutput("")).toBeNull();
  });

  it("maps model names to manifest paths and display names", () => {
    expect(ollamaManifestPath("qwen2.5:7b")).toBe("models/manifests/registry.ollama.ai/library/qwen2.5/7b");
    expect(ollamaManifestPath("qwen2.5")).toBe("models/manifests/registry.ollama.ai/library/qwen2.5/latest");
    expect(ollamaManifestPath("hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M")).toBe(
      "models/manifests/hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF/Q4_K_M",
    );
    expect(normalizeOllamaModelName("registry.ollama.ai/library/qwen2.5:7b")).toBe("qwen2.5:7b");
    expect(normalizeOllamaModelName("qwen2.5")).toBe("qwen2.5:latest");
    expect(normalizeOllamaModelName("team/model:1")).toBe("team/model:1");
    expect(codeOf(() => ollamaManifestPath("../../etc/passwd"))).toBe("ERR_INVALID_MODEL_NAME");
    expect(codeOf(() => ollamaManifestPath("a/b/c/d:1"))).toBe("ERR_INVALID_MODEL_NAME");
  });

  const manifestJson = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: digest("config"), size: 487 },
    layers: [
      { mediaType: "application/vnd.ollama.image.model", digest: digest("weights"), size: 4683073184 },
      { mediaType: "application/vnd.ollama.image.template", digest: digest("template"), size: 1482 },
      { mediaType: "application/vnd.ollama.image.license", digest: digest("license"), size: 11343 },
    ],
  });

  it("lists config and layer blobs and refuses a manifest without weights", () => {
    const layers = parseOllamaManifest(manifestJson);
    expect(layers.map((l) => l.digest)).toEqual([digest("config"), digest("weights"), digest("template"), digest("license")]);
    expect(() => parseOllamaManifest(JSON.stringify({ layers: [] }))).toThrow("no model weights layer");
  });

  it("verifies the on-disk manifest against the digest the runtime reported (run mode)", async () => {
    const reported = `sha256:${computeSha256(manifestJson)}`;
    const { entry, manifest } = await verifyProvisionedModel({
      runtime: "ollama",
      name: "qwen2.5:7b",
      manifestDigest: reported,
      manifestJson,
      platform: "linux/amd64",
      resolvedAt: "2026-09-11T00:00:00.000Z",
    });

    expect(entry).toEqual({
      runtime: "ollama",
      name: "qwen2.5:7b",
      manifestDigest: reported,
      layers: parseOllamaManifest(manifestJson),
      resolvedAt: "2026-09-11T00:00:00.000Z",
    });
    expect(manifest.id).toBe("ollama:qwen2.5:7b");
    expect(manifest.type).toBe("model");
    expect(manifest.sourceUri).toBe("https://registry.ollama.ai/library/qwen2.5:7b");
    expect(manifest.architecture).toBe("amd64");
    expect(manifest.license).toBe(`blob:${digest("license")}`);
    expect(manifest.digests.weightsDigest).toBe(digest("weights"));
    expect(manifest.digests.templateDigest).toBe(digest("template"));
  });

  it("fails when the manifest on disk does not match the reported digest", async () => {
    await expect(
      verifyProvisionedModel({
        runtime: "ollama",
        name: "qwen2.5:7b",
        manifestDigest: digest("some other manifest"),
        manifestJson,
        platform: "linux/amd64",
      }),
    ).rejects.toThrow("hash mismatch on run");
  });
});
