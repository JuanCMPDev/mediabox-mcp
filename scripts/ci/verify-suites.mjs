#!/usr/bin/env node
/**
 * Gate G01 & HAR-04: verify-suites.mjs
 * Runs test suites for all registered workspaces and verifies:
 * - All suites complete with exit code 0
 * - Non-empty test executions (tests found and passed)
 * - Zero unexpected skips
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

console.log("=== Gate G01 / HAR-04: Running and Verifying All Test Suites ===");

// Packages required to have active, passing test suites
const TEST_PACKAGES = [
  { name: "@mediabox/chat-core", minTests: 10 },
  { name: "@mediabox/core", minTests: 50 },
  { name: "mediabox-mcp", minTests: 100 },
  { name: "create-mediabox", minTests: 10 },
];

let hasFailure = false;

for (const pkg of TEST_PACKAGES) {
  console.log(`\n--- Running tests for ${pkg.name} ---`);
  const isWindows = process.platform === "win32";
  const npmCmd = isWindows ? "npm.cmd" : "npm";

  const proc = spawnSync(npmCmd, ["run", "test", "-w", pkg.name], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: true,
  });

  const output = (proc.stdout || "") + "\n" + (proc.stderr || "");
  console.log(output);

  if (proc.status !== 0) {
    console.error(`FAILED: ${pkg.name} test command exited with code ${proc.status}`);
    hasFailure = true;
    continue;
  }

  // Parse test numbers specifically from the "Tests" line of vitest output
  // e.g. "Tests  153 passed (153)" or "Tests  1 failed | 152 passed"
  const testsLine = output.match(/Tests\s+(.+)$/m);
  let passedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  if (testsLine) {
    const passedMatch = testsLine[1].match(/(\d+)\s+passed/);
    const skippedMatch = testsLine[1].match(/(\d+)\s+skipped/);
    const failedMatch = testsLine[1].match(/(\d+)\s+failed/);

    passedCount = passedMatch ? parseInt(passedMatch[1], 10) : 0;
    skippedCount = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;
    failedCount = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  }

  if (failedCount > 0) {
    console.error(`FAILED: ${pkg.name} reported ${failedCount} failing tests.`);
    hasFailure = true;
  } else if (passedCount < pkg.minTests) {
    console.error(
      `FAILED: ${pkg.name} ran fewer tests (${passedCount}) than required (${pkg.minTests}). Empty or missing suite?`
    );
    hasFailure = true;
  } else if (skippedCount > 0) {
    console.error(`FAILED: ${pkg.name} reported ${skippedCount} skipped tests (unexpected skips not allowed by HAR-04).`);
    hasFailure = true;
  } else {
    console.log(`✓ ${pkg.name}: ${passedCount} tests passed, 0 skipped, 0 failed.`);
  }
}

if (hasFailure) {
  console.error("\nGate G01 / HAR-04 FAILED: One or more package suites failed or had unexpected skips/empty suites.");
  process.exit(1);
}

console.log("\n✓ Gate G01 / HAR-04 PASSED: All registered package suites passed with zero skips.");
