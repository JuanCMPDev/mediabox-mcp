/* ─── LLM provider singleton ─────────────────────────────────────────────────
 * Resolved once from environment variables; fails gracefully so the server
 * starts even without LLM keys configured.
 * ──────────────────────────────────────────────────────────────────────── */
import { resolveProvider } from "@mediabox/chat-core";
import type { StreamProvider } from "@mediabox/chat-core";
import type { ChatInfo } from "@mediabox/contracts";

let _provider: StreamProvider | null = null;
let _initError: string | null = null;

export function getChatProvider(): StreamProvider {
  if (_provider) return _provider;
  if (_initError) throw new Error(_initError);

  try {
    _provider = resolveProvider({
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GOOGLE_AI_API_KEY:  process.env.GOOGLE_AI_API_KEY,
      LLM_MODEL:          process.env.LLM_MODEL || process.env.LOCAL_LLM_MODEL,
      LLM_PROVIDER:       process.env.LLM_PROVIDER,
      LOCAL_BASE_URL:     process.env.LOCAL_BASE_URL || process.env.LOCAL_LLM_BASE_URL,
      LOCAL_RUNTIME:      process.env.LOCAL_RUNTIME || process.env.LOCAL_LLM_RUNTIME,
      LOCAL_ALLOW_LAN:    process.env.LOCAL_ALLOW_LAN || (process.env.INFERENCE_ALLOW_LAN === "true" ? "1" : undefined),
    });
    console.log(`[chat] LLM provider: ${_provider.providerName} / ${_provider.model}`);
    return _provider;
  } catch (err) {
    _initError = err instanceof Error ? err.message : String(err);
    console.warn(`[chat] No LLM provider configured — chat disabled. (${_initError})`);
    throw new Error(_initError);
  }
}

export function resetChatProviderForTesting(): void {
  _provider = null;
  _initError = null;
}

export function chatProviderInfo(): ChatInfo | null {
  try {
    const p = getChatProvider();
    const isLocal = p.providerName === "local";
    return {
      provider: p.providerName,
      model: p.model,
      mode: isLocal ? "local" : "cloud",
      runtime: (p as any).runtime,
      backend: process.env.INFERENCE_BACKEND || (isLocal ? "auto" : undefined),
      contextTokens: (p as any).contextTokens,
      agentCompatible: true,
    };
  } catch {
    return null;
  }
}
