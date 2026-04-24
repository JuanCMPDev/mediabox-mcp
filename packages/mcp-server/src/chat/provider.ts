/* ─── LLM provider singleton ─────────────────────────────────────────────────
 * Resolved once from environment variables; fails gracefully so the server
 * starts even without LLM keys configured.
 * ──────────────────────────────────────────────────────────────────────── */
import { resolveProvider } from "@mediabox/chat-core";
import type { StreamProvider } from "@mediabox/chat-core";

let _provider: StreamProvider | null = null;
let _initError: string | null = null;

export function getChatProvider(): StreamProvider {
  if (_provider) return _provider;
  if (_initError) throw new Error(_initError);

  try {
    _provider = resolveProvider({
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GOOGLE_AI_API_KEY:  process.env.GOOGLE_AI_API_KEY,
      LLM_MODEL:          process.env.LLM_MODEL,
      LLM_PROVIDER:       process.env.LLM_PROVIDER,
    });
    console.log(`[chat] LLM provider: ${_provider.providerName} / ${_provider.model}`);
    return _provider;
  } catch (err) {
    _initError = err instanceof Error ? err.message : String(err);
    console.warn(`[chat] No LLM provider configured — chat disabled. (${_initError})`);
    throw new Error(_initError);
  }
}

export function chatProviderInfo(): { provider: string; model: string } | null {
  try {
    const p = getChatProvider();
    return { provider: p.providerName, model: p.model };
  } catch {
    return null;
  }
}
