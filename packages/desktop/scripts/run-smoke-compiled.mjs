#!/usr/bin/env node
/** Compile and execute the desktop subprocess smoke; always remove its temp binary. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--node-executable" || !args[1])) {
  console.error("Usage: run-smoke-compiled.mjs [--node-executable <path>]");
  process.exit(1);
}

function targetForHost() {
  const { platform, arch } = process;
  if (platform === "win32" && arch === "x64") return "bun-windows-x64";
  if (["darwin", "linux"].includes(platform) && ["arm64", "x64"].includes(arch)) {
    return `bun-${platform}-${arch}`;
  }
  throw new Error(`Unsupported host: ${platform}/${arch}`);
}

let tempDir;
try {
  const target = targetForHost();
  tempDir = await mkdtemp(path.join(os.tmpdir(), "mediabox-desktop-smoke-"));
  const outfile = path.join(tempDir, process.platform === "win32" ? "smoke-execa.exe" : "smoke-execa");
  const entry = path.join(desktopRoot, "scripts/smoke-execa.mjs");
  console.log(`[smoke] temporary directory: ${tempDir}`);
  console.log(`[smoke] compiling for ${target}`);
  // execa resolves Windows command shims; arguments do not need shell:true.
  await execa("bun", ["build", "--compile", `--target=${target}`, entry, "--outfile", outfile], {
    stdio: "inherit", cwd: desktopRoot, timeout: 120_000,
  });
  console.log("[smoke] running compiled subprocess assertions");
  await execa(outfile, ["--node-executable", args[1] ?? process.execPath], {
    stdio: "inherit", timeout: 60_000,
  });
} catch (error) {
  console.error(`[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
