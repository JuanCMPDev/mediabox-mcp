#!/usr/bin/env node
/**
 * Driver for the bun-compile smoke test:
 *   1. Auto-detects host triple → picks the matching Bun target.
 *   2. Compiles `smoke-execa.mjs` to a single binary.
 *   3. Runs the binary inheriting stdio.
 *
 * Replaces a one-liner npm script that broke on Windows because cmd.exe
 * requires `.\binary.exe` for PATH-less invocation.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");

function targetForHost() {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32")  return "bun-windows-x64";
  if (p === "darwin") return a === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64";
  if (p === "linux")  return a === "arm64" ? "bun-linux-arm64"  : "bun-linux-x64";
  throw new Error(`Unsupported host: ${p}/${a}`);
}

const exeExt  = process.platform === "win32" ? ".exe" : "";
const outfile = path.resolve(ROOT, `.smoke-execa${exeExt}`);
const entry   = path.resolve(ROOT, "scripts/smoke-execa.mjs");

console.log(`[smoke] compiling for ${targetForHost()}…`);
execFileSync(
  "bun",
  ["build", "--compile", `--target=${targetForHost()}`, entry, "--outfile", outfile],
  { stdio: "inherit", cwd: ROOT, shell: process.platform === "win32" },
);

console.log(`[smoke] running ${path.relative(ROOT, outfile)}…`);
execFileSync(outfile, [], { stdio: "inherit" });
