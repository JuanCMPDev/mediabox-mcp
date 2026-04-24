/* ─── NDJSON streaming consumer for POST /api/chat/stream ───────────────────
 * Uses fetch + ReadableStream (not EventSource) to support custom auth headers.
 * Each line from the server is a JSON-serialized ChatEvent.
 * ──────────────────────────────────────────────────────────────────────── */
import type { ChatEvent } from '@mediabox/contracts';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const KEY  = import.meta.env.VITE_INTERNAL_API_KEY || '';

export async function* streamChat(
  message: string,
  conversationId?: string,
): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, conversationId }),
  });

  if (!res.ok) {
    throw new Error(`Chat API ${res.status}: ${await res.text()}`);
  }

  if (!res.body) throw new Error('No response body');

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as ChatEvent;
        } catch {
          console.warn('[chat-stream] malformed event:', trimmed);
        }
      }
    }
    // Flush any remaining bytes
    if (buffer.trim()) {
      try { yield JSON.parse(buffer.trim()) as ChatEvent; } catch {}
    }
  } finally {
    reader.releaseLock();
  }
}
