#!/usr/bin/env node
/**
 * Desktop sidecar subprocess smoke, under Node and bun build --compile.
 * Synthetic Node children exercise execa without requiring Docker, a daemon,
 * or a Tauri/webview session. Any violated assertion fails the process.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--node-executable" || !args[1])) {
  console.error("Usage: smoke-execa.mjs [--node-executable <path>]");
  process.exit(1);
}

// A compiled Bun binary's execPath points to itself, not a JavaScript runner.
const nodeExecutable = args[1] ?? (typeof Bun === "undefined" ? process.execPath : "node");
const fixture = (exitCode) => ["-e", `process.stdout.write('smoke-stdout'); process.stderr.write('smoke-stderr'); process.exitCode = ${exitCode};`];
const options = { stdio: "pipe", timeout: 10_000 };

let failures = 0;
async function check(label, run) {
  try {
    await run();
    console.log(`[OK] ${label}`);
  } catch (error) {
    failures++;
    console.error(`[FAIL] ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check("stdout, stderr and successful exit", async () => {
  const result = await execa(nodeExecutable, fixture(0), options);
  assert.equal(result.stdout, "smoke-stdout");
  assert.equal(result.stderr, "smoke-stderr");
  assert.equal(result.exitCode, 0);
  assert.equal(result.failed, false);
});

await check("nonzero exit remains observable with reject:false", async () => {
  const result = await execa(nodeExecutable, fixture(17), { ...options, reject: false });
  assert.equal(result.stdout, "smoke-stdout");
  assert.equal(result.stderr, "smoke-stderr");
  assert.equal(result.exitCode, 17);
  assert.equal(result.failed, true);
});

await check("nonzero exit rejects with captured output", async () => {
  await assert.rejects(execa(nodeExecutable, fixture(23), options), (error) => {
    assert.equal(error.exitCode, 23);
    assert.equal(error.stdout, "smoke-stdout");
    assert.equal(error.stderr, "smoke-stderr");
    return true;
  });
});

await check("missing executable rejects", async () => {
  const missingCommand = `mediabox-missing-${randomUUID()}`;
  await assert.rejects(execa(missingCommand, [], options), (error) => {
    // On Windows execa's command lookup can fail through cmd.exe with exit=1.
    if (process.platform === "win32" && error.code !== "ENOENT") {
      assert.equal(error.exitCode, 1);
      assert.ok(error.stderr.includes(missingCommand));
    } else {
      assert.equal(error.code, "ENOENT");
    }
    assert.equal(error.failed, true);
    return true;
  });
});

await check("native spawn error rejects with ENOENT", async () => {
  const cwd = path.join(os.tmpdir(), `mediabox-missing-${randomUUID()}`);
  await assert.rejects(execa(nodeExecutable, fixture(0), { ...options, cwd }), (error) => {
    assert.equal(error.code, "ENOENT");
    assert.equal(error.failed, true);
    return true;
  });
});

console.log(`Smoke result: ${failures === 0 ? "PASS" : "FAIL"} (${5 - failures}/5 assertions); runtime ${typeof Bun === "undefined" ? `Node ${process.version}` : `Bun ${Bun.version}`}.`);
process.exitCode = failures === 0 ? 0 : 1;
