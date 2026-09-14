import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parseCanaryOptions, summarizeCanary } from "./local-canary-options.mjs";

function run(args, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./smoke-local-canary.mjs", import.meta.url)), ...args], {
      env: { ...process.env, LOCAL_LLM_RUNTIME: "ollama", LOCAL_LLM_MODEL: "canary-fixture",
        LOCAL_LLM_API_KEY: "", LOCAL_API_KEY: "", OPENROUTER_API_KEY: "", GOOGLE_AI_API_KEY: "",
        GEMINI_API_KEY: "", NO_PROXY: "*", ...overrides },
      windowsHide: true, timeout: 20000,
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
  });
}

test("default requires real inference; simulation must be explicit", () => {
  assert.equal(parseCanaryOptions([], {}).mode, "live");
  assert.equal(parseCanaryOptions(["--scripted"], {}).mode, "scripted");
  assert.throws(() => parseCanaryOptions(["--auto"], {}));
  assert.throws(() => parseCanaryOptions([], { LOCAL_LLM_RUNTIME: "openrouter" }));
});

test("a 3/3 simulation cannot certify compatibility or report hardware timings", () => {
  const input = { mode: "scripted", passedTurns: 3, ledger: [1, 2, 3], unexpectedCalls: [], failed: false, measurements: [1] };
  const report = summarizeCanary(input);
  assert.equal(report.passed, true);
  assert.equal(report.agentCompatible, null);
  assert.equal(report.certified, false);
  assert.deepEqual(report.measurements, []);
  assert.equal(summarizeCanary({ ...input, ledger: [1, 2, 3, 4] }).passed, false);
  assert.equal(summarizeCanary({ ...input, unexpectedCalls: ["unauthorized"] }).passed, false);
  assert.equal(summarizeCanary({ ...input, failed: true }).passed, false);
});

test("explicit scripted CLI works without contacting the configured endpoint", async () => {
  const result = await run(["--scripted"], { LOCAL_LLM_BASE_URL: "http://192.0.2.1:1" });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /"score":"3\/3"/);
  assert.match(result.output, /"agentCompatible":null/);
  assert.match(result.output, /"evidenceKind":"scripted-harness"/);
});

test("unavailable runtime fails without fallback even with cloud keys present", async () => {
  const server = createServer((_req, res) => { res.writeHead(503); res.end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await run([], {
      LOCAL_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      OPENROUTER_API_KEY: "synthetic-cloud-key", GOOGLE_AI_API_KEY: "synthetic-google-key",
    });
    assert.equal(result.code, 1, result.output);
    assert.doesNotMatch(result.output, /"agentCompatible":true|"mode":"scripted"|synthetic-cloud-key/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
