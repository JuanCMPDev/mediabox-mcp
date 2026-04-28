import { useState, useRef, useCallback, useEffect } from 'react';
import { streamChat }   from './chat-stream';
import { api }          from './api';
import type { ChatMessage, ToolCallRecord } from './types';

const STORAGE_KEY = 'mediabox:conversation-id';

interface ChatState {
  messages:       ChatMessage[];
  isStreaming:    boolean;
  /** Name of the tool currently executing — used by the input's "running" hint.
   *  Per-turn tool history lives on each ChatMessage's `tools` array. */
  activeTool:     string | null;
  conversationId: string | null;
}

export function useChat() {
  const [state, setState] = useState<ChatState>({
    messages:       [],
    isStreaming:    false,
    activeTool:     null,
    conversationId: null,
  });

  /**
   * The conversationId also lives in a ref so `send()` can read its current
   * value synchronously. We can't read it via `setState(s => …)` because in
   * React 18 updater functions are queued and run on the next render, so the
   * captured value is stale by the time `streamChat()` is called — every
   * turn would arrive at the sidecar without a conversationId and the
   * server would mint a fresh conversation, losing all prior context.
   */
  const conversationIdRef = useRef<string | null>(null);

  /** Mirrors state.messages so callbacks (pickChoice) can resolve a card's
   *  value synchronously without needing to be re-created on every render. */
  const messagesRef = useRef<ChatMessage[]>([]);

  const initialized = useRef(false);

  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const savedId = localStorage.getItem(STORAGE_KEY);
    if (!savedId) return;

    conversationIdRef.current = savedId;
    setState(s => ({ ...s, conversationId: savedId }));

    api.chatHistory(savedId)
      .then(entries => {
        if (entries.length === 0) {
          // Expired or never existed
          localStorage.removeItem(STORAGE_KEY);
          conversationIdRef.current = null;
          setState(s => ({ ...s, conversationId: null }));
          return;
        }
        const msgs: ChatMessage[] = entries
          .filter(e => e.content.trim()) // skip empty tool-result entries
          .map((e, i) => ({
            id:        `hist-${i}`,
            role:       e.role,
            content:    e.content,
            timestamp:  new Date(),
          }));
        setState(s => ({ ...s, messages: msgs }));
      })
      .catch(() => {
        // Backend unreachable — start fresh
        localStorage.removeItem(STORAGE_KEY);
        conversationIdRef.current = null;
        setState(s => ({ ...s, conversationId: null }));
      });
  }, []);

  const send = useCallback(async (text: string) => {
    setState(s => {
      if (s.isStreaming || !text.trim()) return s;

      const userMsg: ChatMessage = {
        id:        `u-${Date.now()}`,
        role:      'user',
        content:    text,
        timestamp:  new Date(),
      };
      const assistantMsg: ChatMessage = {
        id:         `a-${Date.now()}`,
        role:       'assistant',
        content:    '',
        timestamp:  new Date(),
        isStreaming: true,
        tools:       [],
      };
      return {
        ...s,
        isStreaming: true,
        messages: [...s.messages, userMsg, assistantMsg],
      };
    });

    try {
      const cid = conversationIdRef.current;

      for await (const evt of streamChat(text, cid ?? undefined)) {
        switch (evt.type) {
          case 'conversation':
            // Sidecar may issue a new id (first turn) or echo the same one.
            // Update the ref BEFORE state so the next send() sees the right value
            // even if the React commit hasn't flushed yet.
            conversationIdRef.current = evt.id;
            localStorage.setItem(STORAGE_KEY, evt.id);
            setState(s => ({ ...s, conversationId: evt.id }));
            break;

          case 'token':
            setState(s => ({
              ...s,
              messages: s.messages.map(m =>
                m.isStreaming ? { ...m, content: m.content + evt.text } : m,
              ),
            }));
            break;

          case 'tool-start': {
            const callId = evt.callId ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const record: ToolCallRecord = {
              callId,
              name:      evt.name,
              status:    'running',
              startedAt: Date.now(),
            };
            setState(s => ({
              ...s,
              activeTool: evt.name,
              messages: s.messages.map(m =>
                m.isStreaming ? { ...m, tools: [...(m.tools ?? []), record] } : m,
              ),
            }));
            break;
          }

          case 'tool-end':
            setState(s => ({
              ...s,
              activeTool: null,
              messages: s.messages.map(m => {
                if (!m.isStreaming) return m;
                const tools = (m.tools ?? []).map(t => {
                  // Match by callId when present; otherwise the most recent
                  // running entry with the same name (covers older engine builds).
                  const matches = evt.callId
                    ? t.callId === evt.callId
                    : t.status === 'running' && t.name === evt.name;
                  if (!matches) return t;
                  return {
                    ...t,
                    status:     evt.ok ? 'ok' as const : 'error' as const,
                    durationMs: evt.durationMs,
                    error:      evt.ok ? undefined : evt.error,
                  };
                });
                return { ...m, tools };
              }),
            }));
            break;

          case 'choices':
            setState(s => ({
              ...s,
              messages: s.messages.map(m =>
                m.isStreaming
                  ? { ...m, choices: { prompt: evt.prompt, items: evt.items } }
                  : m,
              ),
            }));
            break;

          case 'done':
            setState(s => ({
              ...s,
              messages: s.messages.map(m =>
                m.isStreaming ? { ...m, content: evt.fullText, isStreaming: false } : m,
              ),
            }));
            break;

          case 'error':
            setState(s => ({
              ...s,
              messages: s.messages.map(m =>
                m.isStreaming ? { ...m, content: `⚠ ${evt.message}`, isStreaming: false } : m,
              ),
            }));
            break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setState(s => ({
        ...s,
        messages: s.messages.map(m =>
          m.isStreaming ? { ...m, content: `⚠ ${msg}`, isStreaming: false } : m,
        ),
      }));
    } finally {
      setState(s => ({ ...s, isStreaming: false, activeTool: null }));
    }
  }, []);

  /** Clicking a choice card sends its `value` as the next user turn AND
   *  consumes the cards on the originating message so they aren't clickable
   *  twice. */
  const pickChoice = useCallback(async (messageId: string, choiceId: string) => {
    const target = messagesRef.current.find(m => m.id === messageId);
    const item   = target?.choices?.items.find(i => i.id === choiceId);
    if (!item) return;

    setState(s => ({
      ...s,
      messages: s.messages.map(m =>
        m.id === messageId ? { ...m, choices: undefined } : m,
      ),
    }));

    await send(item.value);
  }, [send]);

  const clear = useCallback(async () => {
    const cid = conversationIdRef.current;
    if (cid) api.clearChat(cid).catch(() => {});
    conversationIdRef.current = null;
    localStorage.removeItem(STORAGE_KEY);
    setState({ messages: [], isStreaming: false, activeTool: null, conversationId: null });
  }, []);

  return { ...state, send, pickChoice, clear };
}
