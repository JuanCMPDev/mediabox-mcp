import { execa } from "execa";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PREPARE_ARTIFACTS_PHASE,
  type Deployer,
  type DeployerContext,
  type HealthCheck,
  type PrepareImagesOptions,
  type ProvisionedModel,
  type UpOptions,
} from "./types.js";
import { pollUntilReady, sleep } from "../utils/http.js";
import { tryParseApiKey } from "../utils/xml.js";
import {
  ArtifactError,
} from "../artifacts/manifest.js";
import {
  assertImageConfigPlatform,
  parseDockerServerPlatform,
  parseImagetoolsManifest,
  parseProvisionerOutput,
  type ArtifactPlatform,
  type ResolvedImageDigests,
} from "../artifacts/lock.js";
import { PROVISION_PROFILE, PROVISIONER_SERVICE } from "../generators/docker-compose.js";

export function resolveDeployPath(workDir: string, targetPath: string): string {
  const isPosixAbsolute = targetPath.startsWith("/");
  if (path.isAbsolute(targetPath) || isPosixAbsolute) return targetPath;
  return path.join(workDir, targetPath);
}

export function composeUpArgs(opts?: UpOptions): string[] {
  const args = ["compose", "up", "-d", "--no-build"];
  if (opts?.pull) args.push("--pull", opts.pull);
  if (opts?.recreate) args.push("--force-recreate");
  if (opts?.services?.length) args.push(...opts.services);
  return args;
}

export const SERVER_PLATFORM_ARGS = ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"];

export function imagetoolsInspectArgs(ref: string, format: "{{json .Manifest}}" | "{{json .Image}}"): string[] {
  return ["buildx", "imagetools", "inspect", ref, "--format", format];
}

/**
 * The provisioner image is digest-pinned with `pull_policy: never`; `--pull
 * missing` lets this prepare-only run fetch that exact digest, never a tag.
 */
export function provisionerRunArgs(): string[] {
  return ["compose", "--profile", PROVISION_PROFILE, "run", "--rm", "-T", "--pull", "missing", PROVISIONER_SERVICE];
}

const PINNED_REF = /@sha256:[a-f0-9]{64}$/;

/**
 * Maps one line of provisioner output to an allow-listed progress message, so
 * no raw runtime output reaches the event stream.
 */
export function provisionerProgress(line: string): { message: string; percent?: number } | null {
  const clean = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
  if (!clean) return null;
  const percent = /(\d{1,3})%/.exec(clean);
  const blob = /^pulling ([a-f0-9]{12})/i.exec(clean);
  if (blob) {
    return { message: `Pulling model blob ${blob[1]}`, ...(percent ? { percent: Number(percent[1]) } : {}) };
  }
  if (/^pulling manifest/i.test(clean)) return { message: "Pulling model manifest" };
  if (/^verifying sha256 digest/i.test(clean)) return { message: "Verifying model blob digests" };
  if (/^writing manifest/i.test(clean)) return { message: "Writing model manifest" };
  if (/^success/i.test(clean)) return { message: "Model pulled" };
  if (clean.startsWith("MEDIABOX_MODEL_DIGEST ")) return { message: "Model manifest digest reported" };
  return null;
}

function stderrOf(err: unknown): string {
  return String((err as any)?.stderr || (err as Error)?.message || err).trim();
}

/**
 * Local DockerCliDeployer: shells out to `docker compose` via execa and
 * interacts with the filesystem directly. Consumed by `create-mediabox`
 * (CLI front-end) and by `mcp-server` (desktop wizard front-end). A future
 * RemoteDeployer would implement the same interface over SSH.
 */
export class DockerCliDeployer implements Deployer {
  async prepareImages(ctx: DeployerContext, opts?: PrepareImagesOptions): Promise<void> {
    if (opts?.pinnedImages) {
      // Compose skips `pull_policy: never` services, so pinned images are pulled
      // one by one by digest; nothing here resolves a tag.
      for (const ref of opts.pinnedImages) {
        if (!PINNED_REF.test(ref)) throw new Error(`Refusing to pull unpinned image '${ref}'`);
        try {
          await execa("docker", ["pull", "--quiet", ref], { cwd: ctx.workDir, stdio: "pipe" });
        } catch (err) {
          throw new Error(`Docker pull failed for ${ref}: ${stderrOf(err)}`);
        }
      }
      ctx.onEvent({
        kind: "progress",
        phase: "deploy:prepare-images",
        message: `Pulled ${opts.pinnedImages.length} digest-pinned images`,
      });
    } else {
      // Pull from GHCR (quiet — Docker's ANSI progress breaks non-TTY terminals)
      try {
        await execa("docker", ["compose", "pull", "--quiet"], {
          cwd: ctx.workDir,
          stdio: "pipe",
        });
        ctx.onEvent({
          kind: "progress",
          phase: "deploy:prepare-images",
          message: "Pulled GHCR images",
        });
      } catch (err) {
        const stderr = (err as any).stderr || (err as Error).message;
        throw new Error(`Docker pull failed: ${stderr}`);
      }
    }

    // Build local images if any `build:` directives are present
    try {
      const result = await execa(
        "docker",
        ["compose", "build", "--progress=plain"],
        { cwd: ctx.workDir, stdio: "pipe" },
      );
      if (result.stdout.includes("DONE") || result.stderr.includes("DONE")) {
        ctx.onEvent({
          kind: "progress",
          phase: "deploy:prepare-images",
          message: "Built local images",
        });
      }
    } catch (err) {
      const stderr = (err as any).stderr || "";
      // No `build:` directives → not an error
      if (!stderr.includes("no build") && !stderr.includes("no service")) {
        throw new Error(`Docker build failed: ${stderr}`);
      }
    }
  }

  async up(ctx: DeployerContext, opts?: UpOptions): Promise<void> {
    try {
      await execa("docker", composeUpArgs(opts), { cwd: ctx.workDir, stdio: "pipe" });
    } catch (err) {
      const stderr = (err as any).stderr || (err as Error).message;
      throw new Error(`Docker up failed: ${stderr}`);
    }
  }

  async waitForHealth(ctx: DeployerContext, check: HealthCheck): Promise<boolean> {
    if (check.type === "http") {
      return pollUntilReady(check.target, check.timeoutMs, {
        acceptAny: check.acceptAnyStatus ?? false,
      });
    }

    // file check: poll for a file with optional xmlTag (defaults to ApiKey semantics)
    const absPath = resolveDeployPath(ctx.workDir, check.target);
    const start = Date.now();
    let delay = 2000;
    while (Date.now() - start < check.timeoutMs) {
      try {
        const content = await readFile(absPath, "utf-8");
        if (!check.xmlTag || tryParseApiKey(content)) return true;
      } catch {
        // not yet
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
    }
    return false;
  }

  async readFile(ctx: DeployerContext, relPath: string): Promise<string> {
    return readFile(resolveDeployPath(ctx.workDir, relPath), "utf-8");
  }

  async writeFile(
    ctx: DeployerContext,
    relPath: string,
    content: string,
  ): Promise<void> {
    const abs = resolveDeployPath(ctx.workDir, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }

  async ensureDir(ctx: DeployerContext, relPath: string): Promise<void> {
    await mkdir(resolveDeployPath(ctx.workDir, relPath), { recursive: true });
  }

  async serverPlatform(ctx: DeployerContext): Promise<ArtifactPlatform> {
    let stdout: string;
    try {
      ({ stdout } = await execa("docker", SERVER_PLATFORM_ARGS, { cwd: ctx.workDir, stdio: "pipe" }));
    } catch (err) {
      throw new Error(`Docker version failed: ${stderrOf(err)}`);
    }
    return parseDockerServerPlatform(stdout);
  }

  async resolveImage(
    ctx: DeployerContext,
    ref: string,
    platform: ArtifactPlatform,
  ): Promise<ResolvedImageDigests> {
    const manifest = parseImagetoolsManifest(await this.imagetools(ctx, ref, "{{json .Manifest}}"), platform);
    if (manifest.kind === "manifest") {
      // A single-platform manifest does not name its platform; its config does.
      assertImageConfigPlatform(await this.imagetools(ctx, ref, "{{json .Image}}"), platform, ref);
    }
    return manifest.indexDigest
      ? { indexDigest: manifest.indexDigest, platformDigest: manifest.platformDigest }
      : { platformDigest: manifest.platformDigest };
  }

  async runProvisioner(ctx: DeployerContext): Promise<ProvisionedModel | null> {
    const subprocess = execa("docker", provisionerRunArgs(), { cwd: ctx.workDir, stdio: "pipe", all: true });

    let pending = "";
    let last = { message: "", percent: -1 };
    const emit = (line: string) => {
      const progress = provisionerProgress(line);
      if (!progress) return;
      const percent = progress.percent ?? -1;
      const advanced =
        percent >= 0 && (percent - last.percent >= 10 || (percent === 100 && last.percent !== 100));
      if (progress.message === last.message && !advanced) return;
      last = { message: progress.message, percent };
      ctx.onEvent({ kind: "progress", phase: PREPARE_ARTIFACTS_PHASE, ...progress });
    };
    // Pull progress is redrawn with \r; keep the unfinished tail for the next chunk.
    subprocess.all?.on("data", (chunk: Buffer | string) => {
      const lines = (pending + String(chunk)).split(/[\r\n]+/);
      pending = lines.pop() ?? "";
      lines.forEach(emit);
    });

    try {
      const result = await subprocess;
      emit(pending);
      return parseProvisionerOutput(String(result.stdout));
    } catch (err) {
      const stderr = String((err as any)?.stderr ?? "");
      const marker = /MEDIABOX_PROVISION_ERROR (\S+)/.exec(stderr)?.[1];
      throw new Error(`Model provisioning failed: ${marker ?? (stderr.trim().slice(-400) || stderrOf(err))}`);
    }
  }

  private async imagetools(
    ctx: DeployerContext,
    ref: string,
    format: "{{json .Manifest}}" | "{{json .Image}}",
  ): Promise<string> {
    try {
      const { stdout } = await execa("docker", imagetoolsInspectArgs(ref, format), { cwd: ctx.workDir, stdio: "pipe" });
      return String(stdout);
    } catch (err) {
      if (err instanceof ArtifactError) throw err;
      throw new Error(`Could not resolve image '${ref}': ${stderrOf(err)}`);
    }
  }
}
