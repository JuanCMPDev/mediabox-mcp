/* ─── LLM provider singleton ─────────────────────────────────────────────────
 * Resolved once from environment variables; fails gracefully so the server
 * starts even without LLM keys configured.
 *
 * For local inference the provider also carries the diagnostics the owner needs
 * (runtime, backend, configured vs reported context, canary result) without ever
 * exposing a key (§3.7 / LOC-10).
 * ──────────────────────────────────────────────────────────────────────── */
import { resolveProvider } from "@mediabox/chat-core";
import type { StreamProvider } from "@mediabox/chat-core";
import type { ChatInfo } from "@mediabox/contracts";

let _provider: StreamProvider | null = null;
let _initError: string | null = null;
let _readyPromise: Promise<void> | null = null;
let _diagnosticWarning: string | undefined;

/** Local provider surface beyond StreamProvider — present only in local mode. */
interface LocalProviderLike extends StreamProvider {
  runtime: string;
  baseUrl: string;
  configuredContextTokens: number;
  contextTokens: number;
  ensureRuntimeContext(): Promise<{ effectiveContextTokens: number; warning?: string }>;
  diagnostics: {
    baseUrl: string;
    runtime: string;
    model: string;
    configuredContextTokens: number;
    runtimeContextTokens?: number;
    effectiveContextTokens: number;
    contextWarning?: string;
  };
}

function isLocal(p: StreamProvider): p is LocalProviderLike {
  return p.providerName === "local" && typeof (p as LocalProviderLike).ensureRuntimeContext === "function";
}

export function getChatProvider(): StreamProvider {
  if (_provider) return _provider;
  if (_initError) throw new Error(_initError);

  try {
    _provider = resolveProvider({
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GOOGLE_AI_API_KEY:  process.env.GOOGLE_AI_API_KEY,
      LLM_MODEL:          process.env.LLM_MODEL,
      LLM_PROVIDER:       process.env.LLM_PROVIDER,
      // Canonical names first, short aliases kept for existing installations (§3.6)
      LOCAL_LLM_BASE_URL:       process.env.LOCAL_LLM_BASE_URL,
      LOCAL_LLM_MODEL:          process.env.LOCAL_LLM_MODEL,
      LOCAL_LLM_RUNTIME:        process.env.LOCAL_LLM_RUNTIME,
      LOCAL_LLM_API_KEY:        process.env.LOCAL_LLM_API_KEY,
      LOCAL_LLM_CONTEXT_TOKENS: process.env.LOCAL_LLM_CONTEXT_TOKENS,
      INFERENCE_ALLOW_LAN:      process.env.INFERENCE_ALLOW_LAN,
      INFERENCE_ENDPOINT_HOSTS: process.env.INFERENCE_ENDPOINT_HOSTS,
      LOCAL_BASE_URL:     process.env.LOCAL_BASE_URL,
      LOCAL_MODEL:        process.env.LOCAL_MODEL,
      LOCAL_RUNTIME:      process.env.LOCAL_RUNTIME,
      LOCAL_ALLOW_LAN:    process.env.LOCAL_ALLOW_LAN,
    });
    console.log(`[chat] LLM provider: ${_provider.providerName} / ${_provider.model}`);
    return _provider;
  } catch (err) {
    _initError = err instanceof Error ? err.message : String(err);
    console.warn(`[chat] No LLM provider configured — chat disabled. (${_initError})`);
    throw new Error(_initError);
  }
}

/**
 * Reads the runtime's real context window once, before the first turn, so the agent
 * budget is min(profile, runtime) instead of the configured value (LOC-05).
 */
export async function ensureChatProviderReady(): Promise<void> {
  const provider = getChatProvider();
  if (!isLocal(provider)) return;
  if (!_readyPromise) {
    _readyPromise = provider
      .ensureRuntimeContext()
      .then(result => {
        _diagnosticWarning = result.warning;
      })
      .catch(err => {
        _diagnosticWarning = `Runtime probe failed: ${err instanceof Error ? err.message : String(err)}`;
      });
  }
  await _readyPromise;
}

export function resetChatProviderForTesting(): void {
  _provider = null;
  _initError = null;
  _readyPromise = null;
  _diagnosticWarning = undefined;
}

export function chatProviderInfo(): ChatInfo | null {
  try {
    const p = getChatProvider();
    if (!isLocal(p)) {
      return {
        provider: p.providerName,
        model: p.model,
        mode: "cloud",
      };
    }

    const d = p.diagnostics;
    return {
      provider: p.providerName,
      model: p.model,
      mode: "local",
      runtime: d.runtime,
      backend: process.env.INFERENCE_BACKEND || "auto",
      contextTokens: d.effectiveContextTokens,
      configuredContextTokens: d.configuredContextTokens,
      runtimeContextTokens: d.runtimeContextTokens,
      // Tool-calling compatibility is only asserted by the canary, which runs in the
      // lab against real hardware; until then it is unknown, never a hardcoded true.
      agentCompatible: undefined,
      endpoint: redactEndpoint(d.baseUrl),
      endpointPolicy: process.env.INFERENCE_ALLOW_LAN === "true" ? "lan-allowlist" : "loopback-only",
      warning: d.contextWarning ?? _diagnosticWarning,
    };
  } catch {
    return null;
  }
}

/** Host and port only: never any credential embedded in the URL (LOC-10). */
function redactEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "invalid-url";
  }
}
