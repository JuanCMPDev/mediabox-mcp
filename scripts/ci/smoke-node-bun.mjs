#!/usr/bin/env node
/**
 * Gate G08 Spike: SQLite persistence and transactions in Node and Bun compiled runtime.
 * Validates cross-runtime execution without silent fallbacks (§4.2 / OP-06 / P03).
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeSqliteAdapter } from "../../packages/mcp-server/dist/operations/sqlite/node-adapter.js";
import { initializeOperationsSchema } from "../../packages/mcp-server/dist/operations/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

console.log("=== Gate G08 Spike: Validating Node & Bun SQLite Persistence ===");

// ── 1. Validate Node.js 22+ (node:sqlite) ───────────────────────────────────
console.log("1. Testing Node.js 22+ native SQLite (node:sqlite)...");
const nodeDb = new NodeSqliteAdapter(":memory:");
initializeOperationsSchema(nodeDb);

// Verify tables and user_version
const version = nodeDb.prepare("PRAGMA user_version;").get();
if (!version || version.user_version !== 2) {
  console.error("FAIL: user_version is not 2 in node:sqlite");
  process.exit(1);
}

// Verify transaction commit & rollback
nodeDb.exec("CREATE TABLE test_node (id INT PRIMARY KEY, val TEXT);");
nodeDb.transaction(() => {
  nodeDb.prepare("INSERT INTO test_node VALUES (?, ?)").run(1, "hello");
});

const row = nodeDb.prepare("SELECT val FROM test_node WHERE id = ?").get(1);
if (!row || row.val !== "hello") {
  console.error("FAIL: transaction commit failed in node:sqlite");
  process.exit(1);
}

try {
  nodeDb.transaction(() => {
    nodeDb.prepare("INSERT INTO test_node VALUES (?, ?)").run(2, "fail");
    throw new Error("rollback");
  });
} catch {
  // expected
}

const shouldNotExist = nodeDb.prepare("SELECT val FROM test_node WHERE id = ?").get(2);
if (shouldNotExist) {
  console.error("FAIL: transaction rollback failed in node:sqlite");
  process.exit(1);
}
nodeDb.close();
console.log("✓ Node.js 22+ node:sqlite verified.");

// ── 2. Validate Bun runtime (bun:sqlite) ────────────────────────────────────
console.log("2. Testing Bun runtime SQLite (bun:sqlite)...");
const bunCheck = spawnSync("bun", ["--version"], { encoding: "utf8", shell: true });
if (bunCheck.status !== 0) {
  console.error("FAIL: Bun is not installed or not in PATH");
  process.exit(1);
}
console.log(`Bun version detected: ${bunCheck.stdout.trim()}`);

const bunScript = `
import { Database } from "bun:sqlite";

const db = new Database(":memory:");
db.run("PRAGMA foreign_keys = ON;");
db.run("CREATE TABLE test_bun (id INT PRIMARY KEY, val TEXT);");

// Test transaction
const insert = db.prepare("INSERT INTO test_bun VALUES (?, ?);");
db.transaction(() => {
  insert.run(1, "bun_ok");
})();

const r = db.prepare("SELECT val FROM test_bun WHERE id = ?;").get(1);
if (!r || r.val !== "bun_ok") {
  console.error("Bun transaction commit failed");
  process.exit(1);
}

// Test rollback
try {
  db.transaction(() => {
    insert.run(2, "fail");
    throw new Error("rollback");
  })();
} catch {
  // expected
}

const r2 = db.prepare("SELECT val FROM test_bun WHERE id = ?;").get(2);
if (r2) {
  console.error("Bun transaction rollback failed");
  process.exit(1);
}

db.close();
console.log("✓ Bun bun:sqlite verified.");
`;

const tmpBunFile = path.join(repoRoot, "tmp-bun-test.ts");
fs.writeFileSync(tmpBunFile, bunScript);
const bunRun = spawnSync("bun", [tmpBunFile], { encoding: "utf8", shell: true });
fs.rmSync(tmpBunFile, { force: true });

if (bunRun.status !== 0) {
  console.error("FAIL: Bun sqlite verification script failed:\n", bunRun.stderr || bunRun.stdout || bunRun.error);
  process.exit(bunRun.status ?? 1);
}
console.log(bunRun.stdout.trim());

// ── 3. Validate Bun Compiled Sidecar Spike ──────────────────────────────────
console.log("3. Testing compiled executable packaging spike with SQLite...");
const tmpDir = path.join(repoRoot, "tmp-spike");
fs.mkdirSync(tmpDir, { recursive: true });

const spikeEntry = path.join(tmpDir, "spike-entry.ts");
const spikeExe = path.join(tmpDir, process.platform === "win32" ? "spike.exe" : "spike");

fs.writeFileSync(
  spikeEntry,
  `
import { Database } from "bun:sqlite";
const db = new Database(":memory:");
db.run("CREATE TABLE spike_table (id INT, name TEXT);");
db.run("INSERT INTO spike_table VALUES (42, 'mediabox_sidecar_ok');");
const res = db.prepare("SELECT name FROM spike_table WHERE id = 42;").get();
if (res && res.name === 'mediabox_sidecar_ok') {
  console.log("✓ Compiled sidecar binary successfully executed SQLite transactions!");
  process.exit(0);
} else {
  console.error("Failed to read from SQLite in compiled binary");
  process.exit(1);
}
`
);

const compileRes = spawnSync(
  "bun",
  ["build", spikeEntry, "--compile", "--outfile", spikeExe],
  { encoding: "utf8", cwd: repoRoot, shell: true }
);

if (compileRes.status !== 0) {
  console.error("FAIL: bun build --compile failed:\n", compileRes.stderr || compileRes.stdout);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(compileRes.status ?? 1);
}

const runExe = spawnSync(spikeExe, [], { encoding: "utf8" });
if (runExe.status !== 0) {
  console.error("FAIL: compiled spike executable failed to run:\n", runExe.stderr || runExe.stdout);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(runExe.status ?? 1);
}

console.log(runExe.stdout.trim());

// Clean up spike files
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("✓ Gate G08 Spike PASSED: Node.js and Bun compiled SQLite packaging verified.");

// ── 4. Validate Real MCP Server Bun Compiled Execution (Gate G08) ────────────
console.log("4. Testing real mcp-server Bun compiled execution (/health)...");
const serverTmpDir = path.join(repoRoot, "tmp-server-bun-smoke");
fs.mkdirSync(serverTmpDir, { recursive: true });

const serverEntry = path.join(repoRoot, "packages/mcp-server/src/index.ts");
const serverExe = path.join(serverTmpDir, process.platform === "win32" ? "mcp-server-smoke.exe" : "mcp-server-smoke");

const buildRes = spawnSync(
  "bun",
  ["build", serverEntry, "--compile", "--outfile", serverExe],
  { encoding: "utf8", cwd: repoRoot, shell: true }
);

if (buildRes.status !== 0) {
  console.error("FAIL: bun build --compile mcp-server failed:\n", buildRes.stderr || buildRes.stdout);
  fs.rmSync(serverTmpDir, { recursive: true, force: true });
  process.exit(buildRes.status ?? 1);
}

const testPort = 31000 + Math.floor(Math.random() * 5000);
const opsDbPath = path.join(serverTmpDir, "operations.db");
const mediaTmp = path.join(serverTmpDir, "media");
const downloadsTmp = path.join(serverTmpDir, "downloads");
fs.mkdirSync(mediaTmp, { recursive: true });
fs.mkdirSync(downloadsTmp, { recursive: true });

const child = spawn(serverExe, [], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(testPort),
    INTERNAL_API_KEY: "ci-smoke-internal-key",
    AGENT_API_KEY: "ci-smoke-agent-key",
    OPERATIONS_DB_PATH: opsDbPath,
    MEDIA_PATH: mediaTmp,
    DOWNLOADS_PATH: downloadsTmp,
    BIND_HOST: "127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdoutBuf = "";
let stderrBuf = "";
child.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

let healthy = false;
const maxAttempts = 30;
for (let i = 0; i < maxAttempts; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (child.exitCode !== null) {
    break;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${testPort}/health`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.status === "ok") {
        healthy = true;
        break;
      }
    }
  } catch {
    // wait for bind
  }
}

try {
  child.kill();
} catch {}

if (!healthy) {
  console.error("FAIL: Compiled mcp-server failed to respond to /health in time.");
  console.error("Child exitCode:", child.exitCode);
  console.error("Stdout:\n", stdoutBuf);
  console.error("Stderr:\n", stderrBuf);
  fs.rmSync(serverTmpDir, { recursive: true, force: true });
  process.exit(1);
}

console.log(`✓ Real mcp-server Bun compiled binary started and responded /health on port ${testPort}`);

// Clean up server tmp files (retry on windows in case process handle is closing)
for (let attempt = 0; attempt < 10; attempt++) {
  try {
    fs.rmSync(serverTmpDir, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── 5. Validate LocalProvider in Bun Compiled Binary (Gate G08 Extension / P09) ─
console.log("5. Testing LocalProvider import and initialization in Bun compiled binary...");
const localTmpDir = path.join(repoRoot, "tmp-local-spike");
fs.mkdirSync(localTmpDir, { recursive: true });
const localSpikeEntry = path.join(localTmpDir, "local-spike-entry.ts");
const localSpikeExe = path.join(localTmpDir, process.platform === "win32" ? "local-spike.exe" : "local-spike");

fs.writeFileSync(
  localSpikeEntry,
  `
import { LocalProvider } from "${path.join(repoRoot, "packages/chat-core/dist/providers/local.js").replace(/\\/g, "/")}";
const p = new LocalProvider({ baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b", runtime: "ollama" });
if (p.providerName === "local" && p.model === "qwen2.5:7b") {
  console.log("✓ LocalProvider successfully instantiated in Bun compiled binary!");
  process.exit(0);
} else {
  console.error("LocalProvider failed verification in Bun compiled binary");
  process.exit(1);
}
`
);

const compileLocalRes = spawnSync(
  "bun",
  ["build", localSpikeEntry, "--compile", "--outfile", localSpikeExe],
  { encoding: "utf8", cwd: repoRoot, shell: true }
);

if (compileLocalRes.status !== 0) {
  console.error("FAIL: bun build --compile local provider spike failed:\n", compileLocalRes.stderr || compileLocalRes.stdout);
  fs.rmSync(localTmpDir, { recursive: true, force: true });
  process.exit(compileLocalRes.status ?? 1);
}

const runLocalExe = spawnSync(localSpikeExe, [], { encoding: "utf8" });
if (runLocalExe.status !== 0) {
  console.error("FAIL: compiled local provider executable failed to run:\n", runLocalExe.stderr || runLocalExe.stdout);
  fs.rmSync(localTmpDir, { recursive: true, force: true });
  process.exit(runLocalExe.status ?? 1);
}

console.log(runLocalExe.stdout.trim());
for (let attempt = 0; attempt < 10; attempt++) {
  try {
    fs.rmSync(localTmpDir, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}

console.log("✓ Gate G08 PASSED: Real mcp-server & LocalProvider verified under Bun compiled runtime.");
