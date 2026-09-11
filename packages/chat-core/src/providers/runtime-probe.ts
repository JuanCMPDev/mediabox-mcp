/* ─── Local Runtime Probe and Context Harmonization ────────────────────────
 * Probes available local runtimes and enforces context clipping (§3.3, §3.6 / LOC-05).
 * ──────────────────────────────────────────────────────────────────────── */
import type { LocalRuntimeKind } from '@mediabox/contracts';
import { safeInferenceFetch } from './endpoint-policy.js';

export interface RuntimeProbeResult {
  kind: LocalRuntimeKind;
  baseUrl: string;
  online: boolean;
  version?: string;
  models: string[];
  contextTokens?: number;
  durationMs: number;
  error?: string;
}

export const DEFAULT_RUNTIME_PORTS: Record<LocalRuntimeKind, { port: number; defaultUrl: string }> = {
  ollama:            { port: 11434, defaultUrl: 'http://127.0.0.1:11434' },
  lmstudio:          { port: 1234,  defaultUrl: 'http://127.0.0.1:1234' },
  llamacpp:          { port: 8080,  defaultUrl: 'http://127.0.0.1:8080' },
  vllm:              { port: 8000,  defaultUrl: 'http://127.0.0.1:8000' },
  lemonade:          { port: 8000,  defaultUrl: 'http://127.0.0.1:8000' },
  'openai-compatible': { port: 8000, defaultUrl: 'http://127.0.0.1:8000' },
};

/**
 * Probes a specific local runtime endpoint with a 3-second timeout.
 */
export async function probeRuntime(
  kind: LocalRuntimeKind,
  baseUrl: string,
  timeoutMs = 3000,
): Promise<RuntimeProbeResult> {
  const t0 = Date.now();
  const cleanUrl = baseUrl.replace(/\/+$/, '');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let version: string | undefined;
    let models: string[] = [];
    let contextTokens: number | undefined;

    if (kind === 'ollama') {
      // Version check: GET /api/version
      const vRes = await safeInferenceFetch(`${cleanUrl}/api/version`, { signal: controller.signal });
      if (vRes.ok) {
        const vData = (await vRes.json()) as any;
        version = vData.version;
      }

      // Models check: GET /api/tags
      const mRes = await safeInferenceFetch(`${cleanUrl}/api/tags`, { signal: controller.signal });
      if (mRes.ok) {
        const mData = (await mRes.json()) as any;
        if (Array.isArray(mData.models)) {
          models = mData.models.map((m: any) => m.name || m.model);
        }
      }
    } else if (kind === 'lmstudio') {
      // Models: GET /api/v0/models or /v1/models
      const mRes = await safeInferenceFetch(`${cleanUrl}/v1/models`, { signal: controller.signal });
      if (mRes.ok) {
        const mData = (await mRes.json()) as any;
        if (Array.isArray(mData.data)) {
          models = mData.data.map((m: any) => m.id);
        }
      }
    } else if (kind === 'llamacpp') {
      // Props: GET /props
      const pRes = await safeInferenceFetch(`${cleanUrl}/props`, { signal: controller.signal });
      if (pRes.ok) {
        const pData = (await pRes.json()) as any;
        version = pData.version;
        if (typeof pData.default_generation_settings?.n_ctx === 'number') {
          contextTokens = pData.default_generation_settings.n_ctx;
        }
      }
    } else {
      // Generic / vLLM: GET /v1/models
      const mRes = await safeInferenceFetch(`${cleanUrl}/v1/models`, { signal: controller.signal });
      if (mRes.ok) {
        const mData = (await mRes.json()) as any;
        if (Array.isArray(mData.data)) {
          models = mData.data.map((m: any) => m.id);
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
 * Enforces context window clipping (LOC-05).
 * The effective context is min(profile.contextTokens, runtime.contextTokens).
 * If runtime reports less than profile, clips and returns diagnostic warning.
 */
export function clipContextTokens(
  profileContextTokens: number,
  runtimeContextTokens?: number,
): { effectiveContextTokens: number; clipped: boolean; warning?: string } {
  if (!runtimeContextTokens || runtimeContextTokens <= 0) {
    return {
      effectiveContextTokens: profileContextTokens,
      clipped: false,
    };
  }

  if (runtimeContextTokens < profileContextTokens) {
    return {
      effectiveContextTokens: runtimeContextTokens,
      clipped: true,
      warning: `Runtime context window (${runtimeContextTokens} tokens) is smaller than profile configured (${profileContextTokens} tokens). Clipped to runtime limit.`,
    };
  }

  return {
    effectiveContextTokens: profileContextTokens,
    clipped: false,
  };
}
