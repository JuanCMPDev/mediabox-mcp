#!/usr/bin/env node
/* ─── Local LLM Canary Spike (LOC-01 / Spec §3.6) ───────────────────────────
 * Runs the 3-turn canonical verification against Fake MCP:
 *   Turn 1: Search movie -> calls catalog(search) -> receives mediaRef
 *   Turn 2: Query releases -> calls catalog(releases, mediaRef) -> receives releaseRef
 *   Turn 3: Propose download -> calls catalog(propose_download, releaseRef) -> creates proposal
 * Compatibility score must be 3/3.
 * ──────────────────────────────────────────────────────────────────────── */

import {
  AgentRuntime,
  FakeMcp,
  ScriptedProvider,
  InMemoryHistoryStore,
  InMemoryWorkflowStore,
} from "../../packages/chat-core/dist/index.js";
import { LocalProvider } from "../../packages/chat-core/dist/providers/local.js";
import { parseCanaryOptions, summarizeCanary } from "./local-canary-options.mjs";

const options = parseCanaryOptions(process.argv.slice(2));

console.log("=== Mediabox Local Canary Verification (LOC-01) ===");

const fixtures = {
  search_media: JSON.stringify({
    status: "ok",
    data: [
      {
        id: "movie:tmdb:27205",
        mediaRef: "mref_canary012345",
        title: "Inception",
        year: 2010,
      },
    ],
  }),
  find_releases: JSON.stringify({
    status: "ok",
    data: [
      {
        guid: "rel_canary_1080p",
        releaseRef: "rref_canary012345",
        title: "Inception.2010.1080p.BluRay.x264",
        sizeBytes: 4200000000,
      },
    ],
  }),
  propose_download: JSON.stringify({
    status: "ok",
    planId: "plan_canary_001",
    state: "awaiting_approval",
    operation: "media_download",
    proposalKey: "key_canary_01",
  }),
};

const fakeMcp = new FakeMcp(fixtures);
const historyStore = new InMemoryHistoryStore();
const workflowStore = new InMemoryWorkflowStore();
const conversationId = "canary-conv-" + Date.now();

// Real inference is mandatory unless --scripted was explicitly requested.
// All network access goes through LocalProvider's endpoint policy; no probe or
// runtime failure can silently substitute a scripted provider.
const liveProvider = options.mode === "live" ? new LocalProvider({
  baseUrl: options.baseUrl, model: options.model, runtime: options.runtime,
  contextTokens: 8192, temperature: 0,
}) : null;

const scriptedProvider = new ScriptedProvider([
  // Turn 1: Search media
  [
    {
      type: "tool_call",
      callId: "call_canary_1",
      name: "catalog",
      args: { action: "search", query: "Inception" },
    },
  ],
  [
    {
      type: "text",
      text: "Encontré Inception (2010). ¿Deseas ver las versiones disponibles?",
    },
  ],
  // Turn 2: Releases
  [
    {
      type: "tool_call",
      callId: "call_canary_2",
      name: "catalog",
      args: { action: "releases", mediaRef: "mref_canary012345" },
    },
  ],
  [
    {
      type: "text",
      text: "Versión encontrada: Inception.2010.1080p.BluRay.x264.",
    },
  ],
  // Turn 3: Propose download
  [
    {
      type: "tool_call",
      callId: "call_canary_3",
      name: "catalog",
      args: { action: "propose_download", releaseRef: "rref_canary012345" },
    },
  ],
  [
    {
      type: "text",
      text: "He creado la propuesta para descargar Inception en 1080p.",
    },
  ],
]);

const provider = liveProvider ?? scriptedProvider;
console.log(`[canary] Running canary with provider: ${provider.providerName} (${liveProvider ? "LIVE HOST" : "LABORATORY SCRIPTED"})`);

let passedTurns = 0;
let failed = false;

// ── Turn 1 ──────────────────────────────────────────────────────────────────
console.log("\n--- Canary Turn 1: Search media ---");
const t1_start = Date.now();
let t1_ttft = null;
let t1_tokens = 0;

for await (const evt of AgentRuntime.streamTurn({
  message: "Busca la película Inception",
  conversationId,
  provider,
  mcpCall: fakeMcp.callFn,
  historyStore,
  workflowStore,
  locale: "es",
})) {
  if (evt.type === "error" || evt.type === "guard") failed = true;
  if (evt.type === "token") t1_tokens++;
  if (t1_ttft === null && (evt.type === "tool-start" || evt.type === "token" && evt.text?.trim())) t1_ttft = Date.now() - t1_start;
}

const t1_calls = fakeMcp.ledger.filter((l) => l.tool === "search_media" && l.args.query === "Inception");
if (t1_calls.length === 1) {
  passedTurns++;
  console.log("✓ Turn 1 passed: search_media dispatched and mediaRef extracted");
} else {
  console.error("FAIL: Turn 1 did not dispatch search_media");
}

// ── Turn 2 ──────────────────────────────────────────────────────────────────
console.log("\n--- Canary Turn 2: Query releases ---");
const t2_start = Date.now();
let t2_ttft = null;
let t2_tokens = 0;

for await (const evt of AgentRuntime.streamTurn({
  message: "Muestra las versiones disponibles",
  conversationId,
  provider,
  mcpCall: fakeMcp.callFn,
  historyStore,
  workflowStore,
  locale: "es",
})) {
  if (evt.type === "error" || evt.type === "guard") failed = true;
  if (evt.type === "token") t2_tokens++;
  if (t2_ttft === null && (evt.type === "tool-start" || evt.type === "token" && evt.text?.trim())) t2_ttft = Date.now() - t2_start;
}

const t2_calls = fakeMcp.ledger.filter((l) => l.tool === "find_releases" && l.args.mediaRef === "mref_canary012345");
if (t2_calls.length === 1) {
  passedTurns++;
  console.log("✓ Turn 2 passed: find_releases dispatched with mediaRef");
} else {
  console.error("FAIL: Turn 2 did not dispatch find_releases");
}

// ── Turn 3 ──────────────────────────────────────────────────────────────────
console.log("\n--- Canary Turn 3: Propose download ---");
const t3_start = Date.now();
let t3_ttft = null;
let t3_tokens = 0;

for await (const evt of AgentRuntime.streamTurn({
  message: "Descarga la versión 1080p",
  conversationId,
  provider,
  mcpCall: fakeMcp.callFn,
  historyStore,
  workflowStore,
  locale: "es",
})) {
  if (evt.type === "error" || evt.type === "guard") failed = true;
  if (evt.type === "token") t3_tokens++;
  if (t3_ttft === null && (evt.type === "tool-start" || evt.type === "token" && evt.text?.trim())) t3_ttft = Date.now() - t3_start;
}

const t3_calls = fakeMcp.ledger.filter((l) => l.tool === "propose_download" && l.args.releaseRef === "rref_canary012345");
if (t3_calls.length === 1) {
  passedTurns++;
  console.log("✓ Turn 3 passed: propose_download dispatched with releaseRef");
} else {
  console.error("FAIL: Turn 3 did not dispatch propose_download");
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log("\n=== Canary Summary ===");
console.log(`Flow Score: ${passedTurns}/3`);
console.log(`Total ledger entries: ${fakeMcp.ledger.length}`);

// Token events are text chunks, not tokenizer output tokens. Three timings are
// preliminary observations, not a p95 benchmark or a certification profile.
const measurements = [
  { turn: 1, tool: "search_media", firstVisibleEventMs: t1_ttft, textChunks: t1_tokens },
  { turn: 2, tool: "find_releases", firstVisibleEventMs: t2_ttft, textChunks: t2_tokens },
  { turn: 3, tool: "propose_download", firstVisibleEventMs: t3_ttft, textChunks: t3_tokens },
];
const report = summarizeCanary({ ...options, passedTurns, ledger: fakeMcp.ledger,
  unexpectedCalls: fakeMcp.unexpectedCalls, failed, measurements });
console.log(JSON.stringify(report));

if (!report.passed) {
  console.error("Canary FAILED or runtime unavailable; no compatibility evidence. No fallback was used.");
  process.exit(1);
}

console.log(options.mode === "live"
  ? "✓ LOC-01 live canary PASSED. A performance benchmark is still required for certification."
  : "✓ Scripted harness PASSED. Model compatibility and performance were not evaluated.");
process.exit(0);
