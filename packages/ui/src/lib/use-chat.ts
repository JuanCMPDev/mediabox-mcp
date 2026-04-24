import { useState, useRef, useCallback, useEffect } from 'react';
import { streamChat }   from './chat-stream';
import { api }          from './api';
import type { ChatMessage } from './types';

const STORAGE_KEY = 'mediabox:conversation-id';

interface ChatState {
  messages:       ChatMessage[];
  isStreaming:    boolean;
  activeTool:     string | null;
  conversationId: string | null;
}

export function useChat() {
  const [state, setState] = useState<ChatState>({
    messages:       [],
    isStreaming:    false,
    activeTool:     null,
    conversationId: () => localStorage.getItem(STORAGE_KEY),
  } as unknown as ChatState);

  // Separate init to avoid running setState inside useState initializer
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const savedId = localStorage.getItem(STORAGE_KEY);
    if (!savedId) return;

    setState(s => ({ ...s, conversationId: savedId }));

    api.chatHistory(savedId)
      .then(entries => {
        if (entries.length === 0) {
          // Expired or never existed
          localStorage.removeItem(STORAGE_KEY);
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
      };
      return {
        ...s,
        isStreaming: true,
        messages: [...s.messages, userMsg, assistantMsg],
      };
    });

    const assistantId = `a-${Date.now()}`;

    try {
      let cid: string | null = null;
      setState(s => { cid = s.conversationId; return s; });

      for await (const evt of streamChat(text, cid ?? undefined)) {
        setState(s => {
          switch (evt.type) {
            case 'conversation':
              localStorage.setItem(STORAGE_KEY, evt.id);
              return { ...s, conversationId: evt.id };

            case 'token':
              return {
                ...s,
                messages: s.messages.map(m =>
                  m.isStreaming ? { ...m, content: m.content + evt.text } : m
                ),
              };

            case 'tool-start':
              return { ...s, activeTool: evt.name };

            case 'tool-end':
              return { ...s, activeTool: null };

            case 'done':
              return {
                ...s,
                messages: s.messages.map(m =>
                  m.isStreaming ? { ...m, content: evt.fullText, isStreaming: false } : m
                ),
              };

            case 'error':
              return {
                ...s,
                messages: s.messages.map(m =>
                  m.isStreaming ? { ...m, content: `⚠ ${evt.message}`, isStreaming: false } : m
                ),
              };

            default:
              return s;
          }
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setState(s => ({
        ...s,
        messages: s.messages.map(m =>
          m.isStreaming ? { ...m, content: `⚠ ${msg}`, isStreaming: false } : m
        ),
      }));
    } finally {
      void assistantId; // avoid unused var lint
      setState(s => ({ ...s, isStreaming: false, activeTool: null }));
    }
  }, []);

  const clear = useCallback(async () => {
    setState(s => {
      if (s.conversationId) api.clearChat(s.conversationId).catch(() => {});
      return { messages: [], isStreaming: false, activeTool: null, conversationId: null };
    });
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return { ...state, send, clear };
}
