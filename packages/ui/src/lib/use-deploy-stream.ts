import { useState, useCallback, useRef } from 'react';
import type { DeployConfig, DeployEvent, SetupStatus } from '@mediabox/contracts';
import { getRuntimeConfig } from './runtime-config';

export interface DeployState {
  phase:       'idle' | 'starting' | 'running' | 'finished' | 'error';
  events:      DeployEvent[];
  warnings:    string[];
  error:       string | null;
  ok:          boolean | null;
  durationMs:  number | null;
}

const initialState: DeployState = {
  phase: 'idle',
  events: [],
  warnings: [],
  error: null,
  ok: null,
  durationMs: null,
};

/**
 * Drives a POST /api/setup/start NDJSON stream. Each line is a SetupStatus.
 * Exposes a flat state shape so the progress UI can render directly from it.
 */
export function useDeployStream() {
  const [state, setState] = useState<DeployState>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (config: DeployConfig, workDir: string, generateOnly = false) => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setState({ ...initialState, phase: 'starting' });

    const { apiUrl, internalApiKey } = getRuntimeConfig();

    let res: Response;
    try {
      res = await fetch(`${apiUrl}/api/setup/start`, {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${internalApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ config, workDir, generateOnly }),
        signal: abortRef.current.signal,
      });
    } catch (err) {
      setState(s => ({ ...s, phase: 'error', error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      setState(s => ({ ...s, phase: 'error', error: `HTTP ${res.status}: ${text || 'no body'}` }));
      return;
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    setState(s => ({ ...s, phase: 'running' }));

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const status = JSON.parse(line) as SetupStatus;
            applyStatus(setState, status);
          } catch {
            console.warn('[deploy-stream] malformed line:', line);
          }
        }
      }
      if (buffer.trim()) {
        try {
          applyStatus(setState, JSON.parse(buffer.trim()) as SetupStatus);
        } catch { /* ignore */ }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setState(s => ({ ...s, phase: 'error', error: err instanceof Error ? err.message : String(err) }));
    } finally {
      reader.releaseLock();
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState(s => ({ ...s, phase: 'error', error: 'Cancelled by user' }));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(initialState);
  }, []);

  return { state, start, cancel, reset };
}

function applyStatus(setState: (fn: (s: DeployState) => DeployState) => void, status: SetupStatus): void {
  switch (status.type) {
    case 'starting':
      setState(s => ({ ...s, phase: 'starting' }));
      break;
    case 'event':
      setState(s => ({ ...s, phase: 'running', events: [...s.events, status.event] }));
      break;
    case 'finished':
      setState(s => ({
        ...s,
        phase: 'finished',
        ok: status.ok,
        warnings: status.warnings,
        durationMs: status.durationMs,
      }));
      break;
    case 'error':
      setState(s => ({ ...s, phase: 'error', error: status.message }));
      break;
  }
}
