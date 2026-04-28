#!/usr/bin/env node
/**
 * Compile `mcp-server` to a self-contained binary using `bun build --compile`,
 * then place it at `packages/desktop/src-tauri/binaries/mediabox-mcp-<host-triple>(.exe)`,
 * which is exactly where Tauri looks for sidecars declared in
 * `tauri.conf.json#bundle.externalBin`.
 *
 * Auto-detects the host target triple via `rustc -vV`. To cross-compile, set
 * the TAURI_TARGET env var to the desired Tauri triple (e.g.
 * `x86_64-apple-darwin`).
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const ENTRY = path.resolve(REPO_ROOT, "packages/mcp-server/src/index.ts");
const OUT_DIR = path.resolve(__dirname, "..", "src-tauri", "binaries");

function hostTriple() {
  if (process.env.TAURI_TARGET) return process.env.TAURI_TARGET;
  try {
    const out = execSync("rustc -vV", { encoding: "utf8" });
    const m = out.match(/host:\s+(\S+)/);
    if (!m) throw new Error("could not parse `rustc -vV` host line");
    return m[1];
  } catch (err) {
    console.error("[sidecar] rustc not found in PATH. Install Rust or set TAURI_TARGET.");
    throw err;
  }
}

function bunTargetFor(triple) {
  if (triple.includes("windows")) return "bun-windows-x64";
  if (triple.startsWith("aarch64") && triple.includes("darwin")) return "bun-darwin-arm64";
  if (triple.includes("darwin")) return "bun-darwin-x64";
  if (triple.startsWith("aarch64") && triple.includes("linux")) return "bun-linux-arm64";
  if (triple.includes("linux")) return "bun-linux-x64";
  throw new Error(`Unsupported Tauri triple: ${triple}`);
}

function main() {
  if (!existsSync(ENTRY)) {
    console.error(`[sidecar] entry point not found: ${ENTRY}`);
    process.exit(1);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const triple = hostTriple();
  const bunTarget = bunTargetFor(triple);
  const exeExt = triple.includes("windows") ? ".exe" : "";

  // Bun cannot write directly to `mediabox-mcp-<triple>` because of how it parses
  // the outfile flag, so we write to a temp file and then rename.
  const tmpName = `mediabox-mcp.tmp${exeExt}`;
  const tmpPath = path.resolve(OUT_DIR, tmpName);
  const finalName = `mediabox-mcp-${triple}${exeExt}`;
  const finalPath = path.resolve(OUT_DIR, finalName);

  console.log(`[sidecar] target: ${triple}  →  ${bunTarget}`);
  console.log(`[sidecar] entry:  ${path.relative(REPO_ROOT, ENTRY)}`);
  console.log(`[sidecar] output: ${path.relative(REPO_ROOT, finalPath)}`);

  const args = [
    "build",
    ENTRY,
    "--compile",
    `--target=${bunTarget}`,
    "--outfile",
    tmpPath,
  ];

  const result = spawnSync("bun", args, {
    stdio: "inherit",
    cwd: REPO_ROOT,
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    console.error(`[sidecar] bun build --compile failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }

  if (!existsSync(tmpPath)) {
    console.error(`[sidecar] expected output not found: ${tmpPath}`);
    process.exit(1);
  }

  if (existsSync(finalPath)) rmSync(finalPath);
  copyFileSync(tmpPath, finalPath);
  rmSync(tmpPath);

  const sizeMb = (statSync(finalPath).size / 1024 / 1024).toFixed(1);
  console.log(`[sidecar] ✓ wrote ${finalName} (${sizeMb} MB)`);
}

main();
