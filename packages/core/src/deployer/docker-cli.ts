import { execa } from "execa";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Deployer, DeployerContext, HealthCheck } from "./types.js";
import { pollUntilReady, sleep } from "../utils/http.js";
import { tryParseApiKey } from "../utils/xml.js";

/**
 * Local DockerCliDeployer: shells out to `docker compose` via execa and
 * interacts with the filesystem directly. Consumed by `create-mediabox`
 * (CLI front-end) and by `mcp-server` (desktop wizard front-end). A future
 * RemoteDeployer would implement the same interface over SSH.
 */
export class DockerCliDeployer implements Deployer {
  async prepareImages(ctx: DeployerContext): Promise<void> {
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

  async up(
    ctx: DeployerContext,
    opts?: { recreate?: boolean; services?: string[] },
  ): Promise<void> {
    const args = ["compose", "up", "-d", "--no-build"];
    if (opts?.recreate) args.push("--force-recreate");
    if (opts?.services?.length) args.push(...opts.services);
    try {
      await execa("docker", args, { cwd: ctx.workDir, stdio: "pipe" });
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
    const absPath = path.join(ctx.workDir, check.target);
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
    return readFile(path.join(ctx.workDir, relPath), "utf-8");
  }

  async writeFile(
    ctx: DeployerContext,
    relPath: string,
    content: string,
  ): Promise<void> {
    const abs = path.join(ctx.workDir, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }

  async ensureDir(ctx: DeployerContext, relPath: string): Promise<void> {
    await mkdir(path.join(ctx.workDir, relPath), { recursive: true });
  }
}
