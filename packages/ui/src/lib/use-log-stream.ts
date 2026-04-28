import { useCallback, useRef, useState } from 'react';
import type { LogEvent } from '@mediabox/contracts';
import { getRuntimeConfig } from './runtime-config';

export type LogStreamStatus = 'idle' | 'connecting' | 'live' | 'closed' | 'error';

export interface LogLine {
  line: string;
  ts:   string;
  key:  number; // monotonic counter for React keys
}

const MAX_LINES = 5_000;
let keyCounter = 0;

export function useLogStream() {
  const [lines,  setLines]  = useState<LogLine[]>([]);
  const [status, setStatus] = useState<LogStreamStatus>('idle');
  const [error,  setError]  = useState<string | null>(null);

  const abortRef    = useRef<AbortController | null>(null);
  const serviceRef  = useRef<string | null>(null);

  const open = useCallback(async (service: string, tail = 200) => {
    // Cancel any existing stream first.
    abortRef.current?.abort();

    serviceRef.current = service;
    const controller = new AbortController();
    abortRef.current = controller;

    setLines([]);
    setError(null);
    setStatus('connecting');

    const { apiUrl, internalApiKey } = getRuntimeConfig();
    const url = `${apiUrl}/api/setup/logs/${encodeURIComponent(service)}?tail=${tail}`;

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${internalApiKey}`,
          Accept: 'application/x-ndjson',
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }

      if (!res.body) throw new Error('Response body is null');

      setStatus('live');

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';

        const incoming: LogLine[] = [];
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          let event: LogEvent;
          try { event = JSON.parse(trimmed) as LogEvent; }
          catch { continue; }

          if (event.type === 'log') {
            incoming.push({ line: event.line, ts: event.ts, key: ++keyCounter });
          } else if (event.type === 'closed') {
            setStatus(event.reason === 'error' ? 'error' : 'closed');
            if (event.message) setError(event.message);
          }
        }

        if (incoming.length > 0) {
          setLines(prev => {
            const next = [...prev, ...incoming];
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        }
      }

      // Stream ended cleanly.
      setStatus(s => s === 'live' ? 'closed' : s);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setStatus('idle');
        return;
      }
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const close = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    serviceRef.current = null;
    setStatus('idle');
  }, []);

  const clear = useCallback(() => setLines([]), []);

  return { lines, status, error, open, close, clear };
}
