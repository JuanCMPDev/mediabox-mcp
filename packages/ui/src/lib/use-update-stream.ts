import { useCallback, useRef, useState } from 'react';
import type { PullEvent } from '@mediabox/contracts';
import { getRuntimeConfig } from './runtime-config';

export type UpdateStreamStatus = 'idle' | 'pulling' | 'done' | 'error';

export interface UpdateLine {
  line: string;
  key:  number;
}

let keyCounter = 0;

export function useUpdateStream() {
  const [lines,  setLines]  = useState<UpdateLine[]>([]);
  const [status, setStatus] = useState<UpdateStreamStatus>('idle');
  const [error,  setError]  = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLines([]);
    setError(null);
    setStatus('pulling');

    const { apiUrl, internalApiKey } = getRuntimeConfig();
    const url = `${apiUrl}/api/setup/check-updates`;

    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: {
          Authorization: `Bearer ${internalApiKey}`,
          Accept:        'application/x-ndjson',
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }
      if (!res.body) throw new Error('Response body is null');

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          let event: PullEvent;
          try { event = JSON.parse(trimmed) as PullEvent; } catch { continue; }

          if (event.type === 'log') {
            setLines(prev => [...prev, { line: event.line, key: ++keyCounter }]);
          } else if (event.type === 'done') {
            setStatus(event.ok ? 'done' : 'error');
            if (!event.ok) setError(event.message ?? 'docker compose pull failed');
          }
        }
      }

      setStatus(s => s === 'pulling' ? 'done' : s);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setStatus('idle');
        return;
      }
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
  }, []);

  return { lines, status, error, start, cancel };
}
