export function parseCanaryOptions(args, env = process.env) {
  if (args.some(arg => arg !== "--scripted") || args.length > 1) {
    throw new Error("Usage: smoke-local-canary.mjs [--scripted]");
  }
  const runtime = env.LOCAL_LLM_RUNTIME || "ollama";
  if (!["ollama", "lmstudio", "llamacpp", "vllm", "lemonade", "openai-compatible"].includes(runtime)) {
    throw new Error("LOCAL_LLM_RUNTIME is not a supported local runtime");
  }
  return {
    mode: args.includes("--scripted") ? "scripted" : "live",
    runtime,
    baseUrl: env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:11434",
    model: env.LOCAL_LLM_MODEL || "qwen2.5:7b",
  };
}

export function summarizeCanary({ mode, passedTurns, ledger, unexpectedCalls, failed, measurements, model, runtime }) {
  const passed = passedTurns === 3 && ledger.length === 3 && unexpectedCalls.length === 0 && !failed;
  return {
    schemaVersion: 1,
    canary: "LOC-01",
    mode,
    evidenceKind: mode === "live" ? "live-canary" : "scripted-harness",
    score: `${passedTurns}/3`,
    passed,
    agentCompatible: mode === "live" ? passed : null,
    certified: false,
    model: mode === "live" ? model : null,
    runtime: mode === "live" ? runtime : null,
    measurements: mode === "live" ? measurements : [],
    observedAt: new Date().toISOString(),
  };
}
