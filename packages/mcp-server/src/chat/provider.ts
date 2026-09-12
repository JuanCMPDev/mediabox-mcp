/* ─── LLM provider singleton ─────────────────────────────────────────────────
 * Resolved once from environment variables; fails gracefully so the server
 * starts even without LLM keys configured.
 *
 * For local inference the provider also carries the diagnostics the owner needs
 * (runtime, backend, configured vs reported context, canary result) without ever
 * exposing a key (§3.7 / LOC-10).
 * ──────────────────────────────────────────────────────────────────────── */
import { resolveProvider, parseHostList } from "@mediabox/chat-core";
import type { StreamProvider } from "@mediabox/chat-core";
import type { ChatInfo, PrivacyProfile } from "@mediabox/contracts";
import { sanitizeChatInfo } from "../helpers/diagnostics-sanitizer.js";
import { detectPrivacyIsolation, type PrivacyIsolation } from "../helpers/privacy-isolation.js";
import { RuntimeSupervisor } from "./runtime-supervisor.js";

let _provider: StreamProvider | null = null;
let _initError: string | null = null;
let _readyPromise: Promise<void> | null = null;
let _diagnosticWarning: string | undefined;
let _supervisor: RuntimeSupervisor | null = null;
let _isolation: PrivacyIsolation | null = null;

function privacyIsolation(): PrivacyIsolation {
  if (!_isolation) _isolation = detectPrivacyIsolation();
  return _isolation;
}

/** Lifecycle owner of the local runtime; null for cloud providers (§3.3). */
export function getRuntimeSupervisor(): RuntimeSupervisor | null {
  if (_supervisor) return _supervisor;
  let provider: StreamProvider;
  try {
    provider = getChatProvider();
  } catch {
    return null;
  }
  if (!isLocal(provider)) return null;
  _supervisor = new RuntimeSupervisor({
    target: {
      runtime: provider.runtime,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: process.env.LOCAL_LLM_API_KEY || undefined,
    },
    privacyProfile: process.env.PRIVACY_PROFILE,
    expectedDigest: process.env.LOCAL_LLM_MODEL_DIGEST || undefined,
    policy: {
      allowLan: process.env.INFERENCE_ALLOW_LAN === "true" || process.env.LOCAL_ALLOW_LAN === "1",
      allowedHosts: parseHostList(process.env.INFERENCE_ENDPOINT_HOSTS),
    },
  });
  return _supervisor;
}

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
      LOCAL_LLM_TEMPERATURE:    process.env.LOCAL_LLM_TEMPERATURE,
      LOCAL_LLM_SEED:           process.env.LOCAL_LLM_SEED,
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
  _supervisor?.stop();
  _supervisor = null;
  _isolation = null;
  _provider = null;
  _initError = null;
  _readyPromise = null;
  _diagnosticWarning = undefined;
}

export function chatProviderInfo(): ChatInfo | null {
  try {
    const p = getChatProvider();
    const privacy = (process.env.PRIVACY_PROFILE as PrivacyProfile) || "unverified";
    if (!isLocal(p)) {
      return sanitizeChatInfo({
        provider: p.providerName,
        model: p.model,
        mode: "cloud",
        privacyProfile: privacy,
        privacyIsolation: privacyIsolation(),
      });
    }

    const d = p.diagnostics;
    const supervisor = getRuntimeSupervisor();
    return sanitizeChatInfo({
      privacyIsolation: privacyIsolation(),
      runtimeState: supervisor?.state,
      runtimeReason: supervisor?.reason,
      artifactStatus: supervisor?.artifactStatus,
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
      privacyProfile: privacy,
      warning: d.contextWarning ?? _diagnosticWarning,
    });
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
