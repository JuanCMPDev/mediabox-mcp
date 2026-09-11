/* ─── Local Runtime Probe and Context Harmonization ────────────────────────
 * Probes available local runtimes and reads the real context window (§3.3, §3.6 / LOC-05).
 *
 * Each runtime exposes this on a different endpoint (§3.6 quirks table), so the
 * probe is per runtime rather than a single generic call.
 * ──────────────────────────────────────────────────────────────────────── */
import type { LocalRuntimeKind } from '@mediabox/contracts';
import { safeInferenceFetch, type EndpointPolicyOptions } from './endpoint-policy.js';

export interface RuntimeProbeResult {
  kind: LocalRuntimeKind;
  baseUrl: string;
  online: boolean;
  version?: string;
  models: string[];
  contextTokens?: number;
  supportsTools?: boolean;
  durationMs: number;
  error?: string;
}

export const DEFAULT_RUNTIME_PORTS: Record<LocalRuntimeKind, { port: number; defaultUrl: string }> = {
  ollama:              { port: 11434, defaultUrl: 'http://127.0.0.1:11434' },
  lmstudio:            { port: 1234,  defaultUrl: 'http://127.0.0.1:1234' },
  llamacpp:            { port: 8080,  defaultUrl: 'http://127.0.0.1:8080' },
  vllm:                { port: 8000,  defaultUrl: 'http://127.0.0.1:8000' },
  lemonade:            { port: 8000,  defaultUrl: 'http://127.0.0.1:8000' },
  'openai-compatible': { port: 8000,  defaultUrl: 'http://127.0.0.1:8000' },
};

export interface RuntimeContextInfo {
  contextTokens?: number;
  supportsTools?: boolean;
  version?: string;
  models: string[];
  source: string;
}

interface ProbeOptions {
  policy?: EndpointPolicyOptions;
  apiKey?: string;
  timeoutMs?: number;
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function baseWithoutV1(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function withV1(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  return clean.endsWith('/v1') ? clean : `${clean}/v1`;
}

/** Picks any `*.context_length` entry out of Ollama's model_info map. */
function contextFromOllamaInfo(info: Record<string, unknown> | undefined): number | undefined {
  if (!info) return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) return value;
  }
  return undefined;
}

function numCtxFromParameters(parameters: unknown): number | undefined {
  if (typeof parameters !== 'string') return undefined;
  const match = parameters.match(/num_ctx\s+(\d+)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Reads the context window and tool capability the runtime actually serves for a
 * model. Returns an empty result rather than throwing when the runtime does not
 * expose the information.
 */
export async function readRuntimeContext(
  kind: LocalRuntimeKind,
  baseUrl: string,
  model: string,
  opts: ProbeOptions = {},
): Promise<RuntimeContextInfo> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = authHeaders(opts.apiKey);
  const root = baseWithoutV1(baseUrl);

  try {
    if (kind === 'ollama') {
      const res = await safeInferenceFetch(
        `${root}/api/show`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
          signal: controller.signal,
        },
        opts.policy,
      );
      if (!res.ok) return { models: [], source: '/api/show' };
      const data = (await res.json()) as any;
      const capabilities: string[] = Array.isArray(data.capabilities) ? data.capabilities : [];
      return {
        contextTokens: contextFromOllamaInfo(data.model_info) ?? numCtxFromParameters(data.parameters),
        supportsTools: capabilities.length > 0 ? capabilities.includes('tools') : undefined,
        models: [model],
        source: '/api/show',
      };
    }

    if (kind === 'lmstudio') {
      const res = await safeInferenceFetch(`${root}/api/v0/models`, { headers, signal: controller.signal }, opts.policy);
      if (!res.ok) return { models: [], source: '/api/v0/models' };
      const data = (await res.json()) as any;
      const entries: any[] = Array.isArray(data.data) ? data.data : [];
      const entry = entries.find(m => m.id === model) ?? entries.find(m => m.state === 'loaded');
      return {
        contextTokens:
          typeof entry?.loaded_context_length === 'number'
            ? entry.loaded_context_length
            : typeof entry?.max_context_length === 'number'
              ? entry.max_context_length
              : undefined,
        models: entries.map(m => m.id).filter((id: unknown): id is string => typeof id === 'string'),
        source: '/api/v0/models',
      };
    }

    if (kind === 'llamacpp') {
      const res = await safeInferenceFetch(`${root}/props`, { headers, signal: controller.signal }, opts.policy);
      if (!res.ok) return { models: [], source: '/props' };
      const data = (await res.json()) as any;
      const nCtx =
        typeof data.default_generation_settings?.n_ctx === 'number'
          ? data.default_generation_settings.n_ctx
          : typeof data.n_ctx === 'number'
            ? data.n_ctx
            : undefined;
      return {
        contextTokens: nCtx,
        version: typeof data.build_info === 'string' ? data.build_info : data.version,
        models: typeof data.model_path === 'string' ? [data.model_path] : [],
        source: '/props',
      };
    }

    // vLLM, Lemonade and any other OpenAI-compatible server
    const res = await safeInferenceFetch(`${withV1(baseUrl)}/models`, { headers, signal: controller.signal }, opts.policy);
    if (!res.ok) return { models: [], source: '/v1/models' };
    const data = (await res.json()) as any;
    const entries: any[] = Array.isArray(data.data) ? data.data : [];
    const entry = entries.find(m => m.id === model) ?? entries[0];
    return {
      contextTokens: typeof entry?.max_model_len === 'number' ? entry.max_model_len : undefined,
      models: entries.map(m => m.id).filter((id: unknown): id is string => typeof id === 'string'),
      source: '/v1/models',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes a specific local runtime endpoint, reporting availability plus the
 * context window when the runtime exposes it.
 */
export async function probeRuntime(
  kind: LocalRuntimeKind,
  baseUrl: string,
  timeoutMs = 3000,
  opts: ProbeOptions = {},
): Promise<RuntimeProbeResult> {
  const t0 = Date.now();
  const cleanUrl = baseUrl.replace(/\/+$/, '');
  const root = baseWithoutV1(cleanUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const headers = authHeaders(opts.apiKey);

  try {
    let version: string | undefined;
    let models: string[] = [];
    let contextTokens: number | undefined;

    if (kind === 'ollama') {
      const vRes = await safeInferenceFetch(`${root}/api/version`, { headers, signal: controller.signal }, opts.policy);
      if (vRes.ok) version = ((await vRes.json()) as any).version;

      const mRes = await safeInferenceFetch(`${root}/api/tags`, { headers, signal: controller.signal }, opts.policy);
      if (mRes.ok) {
        const mData = (await mRes.json()) as any;
        if (Array.isArray(mData.models)) models = mData.models.map((m: any) => m.name || m.model);
      }
    } else if (kind === 'lmstudio') {
      const mRes = await safeInferenceFetch(`${root}/api/v0/models`, { headers, signal: controller.signal }, opts.policy);
      if (mRes.ok) {
        const mData = (await mRes.json()) as any;
        if (Array.isArray(mData.data)) {
          models = mData.data.map((m: any) => m.id);
          const loaded = mData.data.find((m: any) => m.state === 'loaded');
          if (typeof loaded?.loaded_context_length === 'number') contextTokens = loaded.loaded_context_length;
        }
      }
    } else if (kind === 'llamacpp') {
      const pRes = await safeInferenceFetch(`${root}/props`, { headers, signal: controller.signal }, opts.policy);
      if (pRes.ok) {
        const pData = (await pRes.json()) as any;
        version = pData.build_info ?? pData.version;
        if (typeof pData.default_generation_settings?.n_ctx === 'number') {
          contextTokens = pData.default_generation_settings.n_ctx;
        }
      }
    } else {
      const mRes = await safeInferenceFetch(`${withV1(cleanUrl)}/models`, { headers, signal: controller.signal }, opts.policy);
      if (mRes.ok) {
        const mData = (await mRes.json()) as any;
        if (Array.isArray(mData.data)) {
          models = mData.data.map((m: any) => m.id);
          const first = mData.data[0];
          if (typeof first?.max_model_len === 'number') contextTokens = first.max_model_len;
        }
      }
    }

    return {
      kind,
      baseUrl: cleanUrl,
      online: true,
      version,
      models,
      contextTokens,
      durationMs: Date.now() - t0,
    };
  } catch (err: any) {
    return {
      kind,
      baseUrl: cleanUrl,
      online: false,
      models: [],
      durationMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Effective context is min(profile, runtime) (§2.4 / LOC-05): a runtime that serves
 * less than the profile configures silently truncates, so the profile is clipped
 * and the discrepancy is reported to diagnostics.
 */
export function clipContextTokens(
  profileContextTokens: number,
  runtimeContextTokens?: number,
): { effectiveContextTokens: number; clipped: boolean; warning?: string } {
  if (!runtimeContextTokens || runtimeContextTokens <= 0) {
    return { effectiveContextTokens: profileContextTokens, clipped: false };
  }

  if (runtimeContextTokens < profileContextTokens) {
    return {
      effectiveContextTokens: runtimeContextTokens,
      clipped: true,
      warning: `Runtime context window (${runtimeContextTokens} tokens) is smaller than the configured profile (${profileContextTokens} tokens). Clipped to the runtime limit.`,
    };
  }

  return { effectiveContextTokens: profileContextTokens, clipped: false };
}
