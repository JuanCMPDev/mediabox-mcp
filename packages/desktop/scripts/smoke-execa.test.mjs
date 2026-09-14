import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const smoke = fileURLToPath(new URL("./smoke-execa.mjs", import.meta.url));
const compiledDriver = fileURLToPath(new URL("./run-smoke-compiled.mjs", import.meta.url));
const missingNode = fileURLToPath(new URL("./deliberately-missing-node.exe", import.meta.url));
const run = (script, args = []) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 180_000 });

test("desktop smoke checks stdout, stderr, exit codes and spawn errors", () => {
  const result = run(smoke);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS \(5\/5 assertions\)/);
});

test("desktop smoke exits nonzero if the subprocess cannot launch", () => {
  const result = run(smoke, ["--node-executable", missingNode]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Smoke result: FAIL/);
  assert.match(result.stderr, /\[FAIL\] stdout, stderr and successful exit/);
});

test("compiled desktop driver propagates assertion failures and removes its binary", () => {
  const result = run(compiledDriver, ["--node-executable", missingNode]);
  assert.equal(result.status, 1, result.stderr);
  // Require proof the compiled binary ran, not just a build/tool lookup failure.
  assert.match(result.stdout, /\[smoke\] running compiled subprocess assertions/);
  assert.match(result.stdout, /Smoke result: FAIL/);
  const directory = result.stdout.match(/\[smoke\] temporary directory: (.+)\r?\n/)?.[1].trim();
  assert.ok(directory, result.stdout);
  assert.equal(fs.existsSync(directory), false, `temporary binary not cleaned: ${directory}`);
});
