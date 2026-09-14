import { parse } from "yaml";
import type { ArtifactManifest } from "../config/types.js";
import {
  ArtifactError,
  computeSha256,
  createArtifactManifest,
  verifyOrProvisionArtifact,
} from "./manifest.js";

/**
 * Artifact lock (§3.2): what `prepare` resolved and `run` is allowed to use.
 * Images are pinned by their platform-specific manifest digest (the multi-arch
 * index is recorded for audit only); models by their manifest digest and blobs.
 * A tag is only a search key: `run` never resolves it again.
 */
export type ArtifactPlatform = "linux/amd64" | "linux/arm64";

export interface LockedImage {
  /** Reference written to the compose file: `repository@platformDigest`. */
  ref: string;
  /** Digest of the multi-arch index / manifest list the tag pointed at, if any. */
  indexDigest?: string;
  /** Digest of the manifest for `platform`; the only value `run` uses. */
  platformDigest: string;
  platform: string;
}

export interface LockedModelLayer {
  mediaType: string;
  digest: string;
  size: number;
}

export interface LockedModel {
  runtime: string;
  name: string;
  manifestDigest: string;
  layers: LockedModelLayer[];
  resolvedAt: string;
}

export interface ArtifactLock {
  schemaVersion: 1;
  resolvedAt: string;
  platform: ArtifactPlatform;
  /** Keyed by the original tag reference found in the generated compose. */
  images: Record<string, LockedImage>;
  /** Keyed by `runtime:model`, e.g. `ollama:qwen2.5:7b`. */
  models: Record<string, LockedModel>;
}

export interface ResolvedImageDigests {
  indexDigest?: string;
  platformDigest: string;
}

export const ARTIFACT_LOCK_FILE = "artifacts.lock.json";
export const ARTIFACT_PLATFORMS: readonly ArtifactPlatform[] = ["linux/amd64", "linux/arm64"];

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
// Leading byte-order mark that PowerShell redirection and some Windows shells add.
const BOM_PREFIX = new RegExp("^" + String.fromCharCode(0xfeff));

export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_DIGEST.test(value);
}

function isArtifactPlatform(value: unknown): value is ArtifactPlatform {
  return typeof value === "string" && (ARTIFACT_PLATFORMS as readonly string[]).includes(value);
}

/** Maps `docker version --format '{{.Server.Os}}/{{.Server.Arch}}'` to a lock platform. */
export function parseDockerServerPlatform(output: string): ArtifactPlatform {
  const [os = "", arch = ""] = output.replace(BOM_PREFIX, "").trim().toLowerCase().split("/");
  const normalizedArch = arch === "x86_64" ? "amd64" : arch === "aarch64" ? "arm64" : arch;
  const platform = `${os}/${normalizedArch}`;
  if (!isArtifactPlatform(platform)) {
    throw new ArtifactError(
      "ERR_UNSUPPORTED_PLATFORM",
      `Docker server platform '${output.trim()}' is not supported for pinned artifacts (expected one of ${ARTIFACT_PLATFORMS.join(", ")})`,
    );
  }
  return platform;
}

// ── Image manifests (docker buildx imagetools inspect) ─────────────────────

const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

export interface ParsedImagetoolsManifest extends ResolvedImageDigests {
  /**
   * `manifest` means the reference is a single-platform manifest: its JSON does
   * not name a platform, so the caller must check the image config before use.
   */
  kind: "index" | "manifest";
}

function parseJsonOutput(json: string, what: string): any {
  try {
    // PowerShell redirection and some Windows shells prepend a BOM.
    return JSON.parse(json.replace(BOM_PREFIX, "").trim());
  } catch {
    throw new ArtifactError("ERR_IMAGETOOLS_OUTPUT", `${what} is not valid JSON`);
  }
}

function isRunnableEntry(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  // BuildKit attaches provenance/SBOM manifests as unknown/unknown entries.
  if (entry.annotations?.["vnd.docker.reference.type"] === "attestation-manifest") return false;
  return entry.platform?.os !== "unknown" && entry.platform?.architecture !== "unknown";
}

/**
 * Parses `docker buildx imagetools inspect <ref> --format '{{json .Manifest}}'`
 * and selects the manifest for `platform`. Accepts an OCI index / Docker
 * manifest list or a single-platform manifest.
 */
export function parseImagetoolsManifest(json: string, platform: ArtifactPlatform): ParsedImagetoolsManifest {
  const doc = parseJsonOutput(json, "imagetools manifest output");
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ArtifactError("ERR_IMAGETOOLS_OUTPUT", "imagetools manifest output is not an object");
  }

  const isIndex = INDEX_MEDIA_TYPES.has(doc.mediaType) || (doc.mediaType === undefined && Array.isArray(doc.manifests));
  if (isIndex) {
    if (!isSha256Digest(doc.digest)) {
      throw new ArtifactError("ERR_INVALID_DIGEST", `Image index digest '${String(doc.digest)}' is not a sha256 digest`);
    }
    const [os, arch] = platform.split("/");
    const entries: any[] = Array.isArray(doc.manifests) ? doc.manifests.filter(isRunnableEntry) : [];
    const candidates = entries.filter((m) => m.platform?.os === os && m.platform?.architecture === arch);
    // Prefer the baseline variant (none, or v8 for arm64) over microarchitecture levels.
    const chosen =
      candidates.find((m) => !m.platform.variant || (arch === "arm64" && m.platform.variant === "v8")) ??
      candidates[0];
    if (!chosen) {
      const available = entries
        .map((m) => [m.platform?.os, m.platform?.architecture, m.platform?.variant].filter(Boolean).join("/"))
        .join(", ");
      throw new ArtifactError(
        "ERR_PLATFORM_NOT_FOUND",
        `Image index ${doc.digest} has no ${platform} manifest (available: ${available || "none"})`,
      );
    }
    if (!isSha256Digest(chosen.digest)) {
      throw new ArtifactError("ERR_INVALID_DIGEST", `Platform manifest digest '${String(chosen.digest)}' is not a sha256 digest`);
    }
    return { kind: "index", indexDigest: doc.digest, platformDigest: chosen.digest };
  }

  if (MANIFEST_MEDIA_TYPES.has(doc.mediaType)) {
    if (!isSha256Digest(doc.digest)) {
      throw new ArtifactError("ERR_INVALID_DIGEST", `Manifest digest '${String(doc.digest)}' is not a sha256 digest`);
    }
    return { kind: "manifest", platformDigest: doc.digest };
  }

  throw new ArtifactError("ERR_IMAGETOOLS_OUTPUT", `Unsupported manifest media type '${String(doc.mediaType)}'`);
}

/**
 * Checks `docker buildx imagetools inspect <ref> --format '{{json .Image}}'` of a
 * single-platform manifest against the platform the lock is being built for.
 */
export function assertImageConfigPlatform(json: string, platform: ArtifactPlatform, ref: string): void {
  const config = parseJsonOutput(json, "imagetools image config output");
  const actual = `${config?.os ?? "unknown"}/${config?.architecture ?? "unknown"}`;
  if (actual !== platform) {
    throw new ArtifactError(
      "ERR_PLATFORM_NOT_FOUND",
      `Image '${ref}' is a single-platform ${actual} image; ${platform} is required`,
    );
  }
}

// ── Compose references ──────────────────────────────────────────────────────

/** Replaces `${VAR:-default}` / `${VAR-default}` with its default; the lock never reads .env. */
function resolveComposeDefaults(value: string): string {
  const resolved = value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g, "$1");
  if (/\$\{|\$[A-Za-z_]/.test(resolved)) {
    throw new ArtifactError(
      "ERR_IMAGE_REF_UNRESOLVED",
      `Image reference '${value}' depends on an environment variable without a default`,
    );
  }
  return resolved;
}

/** `lscr.io/linuxserver/jellyfin:latest` → `lscr.io/linuxserver/jellyfin` (keeps registry ports). */
export function imageRepository(ref: string): string {
  const withoutDigest = ref.split("@")[0];
  const colon = withoutDigest.lastIndexOf(":");
  return colon > withoutDigest.lastIndexOf("/") ? withoutDigest.slice(0, colon) : withoutDigest;
}

export function pinnedImageRef(ref: string, platformDigest: string): string {
  return `${imageRepository(ref)}@${platformDigest}`;
}

type ComposeLike = { services?: Record<string, any> } & Record<string, any>;

function composeDocument(compose: string | ComposeLike): ComposeLike {
  const doc = typeof compose === "string" ? parse(compose) : compose;
  if (!doc || typeof doc !== "object") {
    throw new ArtifactError("ERR_INVALID_COMPOSE", "Compose document is empty or not an object");
  }
  return doc as ComposeLike;
}

/**
 * Every `image:` of the compose file, profiled services included, with compose
 * defaults resolved. Services built from source have no image and are skipped.
 */
export function imageRefsFromCompose(compose: string | ComposeLike): string[] {
  const refs = new Set<string>();
  for (const service of Object.values(composeDocument(compose).services ?? {})) {
    if (service && typeof service.image === "string") refs.add(resolveComposeDefaults(service.image));
  }
  return [...refs].sort();
}

export function lockedImage(ref: string, resolved: ResolvedImageDigests, platform: ArtifactPlatform): LockedImage {
  if (!isSha256Digest(resolved.platformDigest)) {
    throw new ArtifactError("ERR_INVALID_DIGEST", `Resolved digest for '${ref}' is not a sha256 digest`);
  }
  if (resolved.indexDigest !== undefined && !isSha256Digest(resolved.indexDigest)) {
    throw new ArtifactError("ERR_INVALID_DIGEST", `Resolved index digest for '${ref}' is not a sha256 digest`);
  }
  return {
    ref: pinnedImageRef(ref, resolved.platformDigest),
    ...(resolved.indexDigest ? { indexDigest: resolved.indexDigest } : {}),
    platformDigest: resolved.platformDigest,
    platform,
  };
}

/**
 * Returns a copy of the compose object with every image pinned by digest and
 * `pull_policy: never`, so `up` can only use what `prepare` fetched.
 */
export function applyArtifactLock<T extends ComposeLike>(compose: T, lock: ArtifactLock): T {
  validateArtifactLock(lock);
  const out = structuredClone(compose);
  const missing: string[] = [];

  for (const [name, service] of Object.entries(out.services ?? {})) {
    if (!service || typeof service.image !== "string") continue;
    const key = resolveComposeDefaults(service.image);
    const entry = lock.images[key];
    if (!entry) {
      missing.push(`${name} (${key})`);
      continue;
    }
    // Rebuild the service so pull_policy sits next to image in the YAML.
    const pinned: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(service)) {
      if (field === "pull_policy") continue;
      pinned[field] = field === "image" ? entry.ref : value;
      if (field === "image") pinned.pull_policy = "never";
    }
    out.services![name] = pinned;
  }

  if (missing.length > 0) {
    throw new ArtifactError(
      "ERR_ARTIFACT_UNPINNED",
      `No artifact lock entry for ${missing.join(", ")}; run prepare to resolve them by digest`,
    );
  }
  return out;
}

/** Services whose image is not digest-pinned with `pull_policy: never`; strict `run` refuses them. */
export function findUnpinnedImages(compose: string | ComposeLike): string[] {
  const unpinned: string[] = [];
  for (const [name, service] of Object.entries(composeDocument(compose).services ?? {})) {
    if (!service || typeof service.image !== "string") continue;
    if (!/@sha256:[a-f0-9]{64}$/.test(service.image) || service.pull_policy !== "never") unpinned.push(name);
  }
  return unpinned;
}

/** Structural and format validation; returns the lock typed when it passes. */
export function validateArtifactLock(lock: unknown): ArtifactLock {
  const problems: string[] = [];
  const l = lock as Partial<ArtifactLock> | null;

  if (!l || typeof l !== "object") {
    throw new ArtifactError("ERR_INVALID_LOCK", "Artifact lock is not an object");
  }
  if (l.schemaVersion !== 1) problems.push(`schemaVersion must be 1 (got ${String(l.schemaVersion)})`);
  if (typeof l.resolvedAt !== "string" || Number.isNaN(Date.parse(l.resolvedAt))) {
    problems.push("resolvedAt must be an ISO timestamp");
  }
  if (!isArtifactPlatform(l.platform)) problems.push(`platform '${String(l.platform)}' is not supported`);

  if (!l.images || typeof l.images !== "object" || Array.isArray(l.images)) {
    problems.push("images must be an object");
  } else {
    for (const [key, entry] of Object.entries(l.images)) {
      if (!entry || typeof entry !== "object") {
        problems.push(`images['${key}'] must be an object`);
        continue;
      }
      if (!isSha256Digest(entry.platformDigest)) problems.push(`images['${key}'].platformDigest is not a sha256 digest`);
      if (entry.indexDigest !== undefined && !isSha256Digest(entry.indexDigest)) {
        problems.push(`images['${key}'].indexDigest is not a sha256 digest`);
      }
      if (entry.platform !== l.platform) problems.push(`images['${key}'].platform must equal the lock platform`);
      // The pinned ref must be the key's own repository at the locked digest.
      if (isSha256Digest(entry.platformDigest) && entry.ref !== pinnedImageRef(key, entry.platformDigest)) {
        problems.push(`images['${key}'].ref must be ${pinnedImageRef(key, entry.platformDigest)}`);
      }
    }
  }

  if (!l.models || typeof l.models !== "object" || Array.isArray(l.models)) {
    problems.push("models must be an object");
  } else {
    for (const [key, entry] of Object.entries(l.models)) {
      if (!entry || typeof entry !== "object") {
        problems.push(`models['${key}'] must be an object`);
        continue;
      }
      if (!entry.runtime || typeof entry.runtime !== "string") problems.push(`models['${key}'].runtime is required`);
      if (!entry.name || typeof entry.name !== "string") problems.push(`models['${key}'].name is required`);
      if (!isSha256Digest(entry.manifestDigest)) problems.push(`models['${key}'].manifestDigest is not a sha256 digest`);
      if (typeof entry.resolvedAt !== "string" || Number.isNaN(Date.parse(entry.resolvedAt))) {
        problems.push(`models['${key}'].resolvedAt must be an ISO timestamp`);
      }
      if (!Array.isArray(entry.layers) || entry.layers.length === 0) {
        problems.push(`models['${key}'].layers must list the manifest blobs`);
      } else {
        entry.layers.forEach((layer, i) => {
          if (!layer || typeof layer.mediaType !== "string" || !layer.mediaType) {
            problems.push(`models['${key}'].layers[${i}].mediaType is required`);
          }
          if (!isSha256Digest(layer?.digest)) problems.push(`models['${key}'].layers[${i}].digest is not a sha256 digest`);
          if (!Number.isSafeInteger(layer?.size) || layer.size < 0) {
            problems.push(`models['${key}'].layers[${i}].size must be a non-negative integer`);
          }
        });
      }
    }
  }

  if (problems.length > 0) {
    throw new ArtifactError("ERR_INVALID_LOCK", problems.join("; "));
  }
  return l as ArtifactLock;
}

export function serializeArtifactLock(lock: ArtifactLock): string {
  return JSON.stringify(validateArtifactLock(lock), null, 2) + "\n";
}

export function readArtifactLock(json: string): ArtifactLock {
  let doc: unknown;
  try {
    doc = JSON.parse(json.replace(BOM_PREFIX, ""));
  } catch {
    throw new ArtifactError("ERR_INVALID_LOCK", `${ARTIFACT_LOCK_FILE} is not valid JSON`);
  }
  return validateArtifactLock(doc);
}

// ── Models (Ollama) ─────────────────────────────────────────────────────────

/** Line the provisioner prints once the model is pulled: `MEDIABOX_MODEL_DIGEST <name> <sha256:…>`. */
export const MODEL_DIGEST_MARKER = "MEDIABOX_MODEL_DIGEST";

export function parseProvisionerOutput(output: string): { name: string; manifestDigest: string } | null {
  let found: { name: string; manifestDigest: string } | null = null;
  for (const line of output.split(/\r?\n/)) {
    const match = /^MEDIABOX_MODEL_DIGEST (\S+) (sha256:[a-f0-9]{64})$/.exec(line.trim());
    if (match) found = { name: match[1], manifestDigest: match[2] };
  }
  return found;
}

const OLLAMA_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OLLAMA_HOST_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*(?::\d+)?$/;

interface OllamaName {
  host: string;
  namespace: string;
  model: string;
  tag: string;
}

function parseOllamaName(name: string): OllamaName {
  const bare = name.trim().replace(/^[a-z]+:\/\//i, "").split("@")[0];
  const parts = bare.split("/");
  const last = parts[parts.length - 1] ?? "";
  const colon = last.lastIndexOf(":");
  const tag = colon > 0 ? last.slice(colon + 1) : "latest";
  parts[parts.length - 1] = colon > 0 ? last.slice(0, colon) : last;

  let host = "registry.ollama.ai";
  let namespace = "library";
  if (parts.length === 3) [host, namespace] = parts;
  else if (parts.length === 2) namespace = parts[0];
  else if (parts.length !== 1) throw new ArtifactError("ERR_INVALID_MODEL_NAME", `Model name '${name}' is not a valid Ollama name`);

  const model = parts[parts.length - 1];
  if (!OLLAMA_HOST_SEGMENT.test(host) || ![namespace, model, tag].every((s) => OLLAMA_SEGMENT.test(s))) {
    throw new ArtifactError("ERR_INVALID_MODEL_NAME", `Model name '${name}' is not a valid Ollama name`);
  }
  return { host, namespace, model, tag };
}

/** Shortest display form, as Ollama reports it in /api/tags (`qwen2.5:7b`). */
export function normalizeOllamaModelName(name: string): string {
  const n = parseOllamaName(name);
  const prefix = n.host === "registry.ollama.ai" ? (n.namespace === "library" ? "" : `${n.namespace}/`) : `${n.host}/${n.namespace}/`;
  return `${prefix}${n.model}:${n.tag}`;
}

/** Manifest path relative to the Ollama data dir (`/root/.ollama`, `./config/ollama` on the host). */
export function ollamaManifestPath(name: string): string {
  const n = parseOllamaName(name);
  return ["models", "manifests", n.host, n.namespace, n.model, n.tag].join("/");
}

/** Config and layer blobs of an Ollama manifest, in manifest order. */
export function parseOllamaManifest(manifestJson: string): LockedModelLayer[] {
  let doc: any;
  try {
    doc = JSON.parse(manifestJson);
  } catch {
    throw new ArtifactError("ERR_INVALID_MODEL_MANIFEST", "Model manifest is not valid JSON");
  }
  const blobs: any[] = [...(doc?.config ? [doc.config] : []), ...(Array.isArray(doc?.layers) ? doc.layers : [])];
  if (!blobs.some((b) => b?.mediaType === "application/vnd.ollama.image.model")) {
    throw new ArtifactError("ERR_INVALID_MODEL_MANIFEST", "Model manifest has no model weights layer");
  }
  return blobs.map((b, i) => {
    if (typeof b?.mediaType !== "string" || !isSha256Digest(b.digest) || !Number.isSafeInteger(b.size) || b.size < 0) {
      throw new ArtifactError("ERR_INVALID_MODEL_MANIFEST", `Model manifest blob #${i} is malformed`);
    }
    return { mediaType: b.mediaType, digest: b.digest, size: b.size };
  });
}

export interface ProvisionedModelInput {
  runtime: string;
  name: string;
  /** Digest the runtime reported after the pull. */
  manifestDigest: string;
  /** Manifest bytes read from the provisioned volume. */
  manifestJson: string;
  platform: ArtifactPlatform;
  resolvedAt?: string;
}

/**
 * Checks the manifest on disk against the digest the runtime reported, using the
 * same `run`-mode rule as every other artifact (no download, hash must match),
 * and returns the lock entry plus its versioned ArtifactManifest.
 */
export async function verifyProvisionedModel(
  input: ProvisionedModelInput,
): Promise<{ entry: LockedModel; manifest: ArtifactManifest }> {
  if (!isSha256Digest(input.manifestDigest)) {
    throw new ArtifactError("ERR_INVALID_DIGEST", `Model digest for '${input.name}' is not a sha256 digest`);
  }
  const layers = parseOllamaManifest(input.manifestJson);
  const layer = (mediaType: string) => layers.find((l) => l.mediaType === mediaType)?.digest;
  const n = parseOllamaName(input.name);
  const resolvedAt = input.resolvedAt ?? new Date().toISOString();
  const sizeBytes = Buffer.byteLength(input.manifestJson, "utf8");
  const licenseLayer = layer("application/vnd.ollama.image.license");

  const manifest = createArtifactManifest({
    id: `${input.runtime}:${input.name}`,
    type: "model",
    sourceUri: `https://${n.host}/${n.namespace}/${n.model}:${n.tag}`,
    sha256: input.manifestDigest.slice("sha256:".length),
    sizeBytes,
    platform: "linux",
    architecture: input.platform.split("/")[1],
    // The license text travels as a blob; point at it rather than guess a name.
    license: licenseLayer ? `blob:${licenseLayer}` : "unrecorded",
    resolvedAt,
    digests: {
      platformDigest: input.manifestDigest,
      weightsDigest: layer("application/vnd.ollama.image.model"),
      templateDigest: layer("application/vnd.ollama.image.template"),
    },
  });

  await verifyOrProvisionArtifact("run", manifest, {
    exists: true,
    sha256: computeSha256(input.manifestJson),
    sizeBytes,
  });

  return {
    entry: { runtime: input.runtime, name: input.name, manifestDigest: input.manifestDigest, layers, resolvedAt },
    manifest,
  };
}
