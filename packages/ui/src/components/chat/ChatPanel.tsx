import { useState, useCallback } from 'react';
import { MessageSquare } from 'lucide-react';
import styles from './ChatPanel.module.css';
import { GlassCard } from '@/components/atoms/GlassCard';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { MOCK_CHAT_MESSAGES, MOCK_ASSISTANT_RESPONSES } from '@/mocks/data';
import type { ChatMessage } from '@/lib/types';

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>(MOCK_CHAT_MESSAGES);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isTyping) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    // Mock response delay
    const delay = 1200 + Math.random() * 800;
    setTimeout(() => {
      const reply =
        MOCK_ASSISTANT_RESPONSES[
          Math.floor(Math.random() * MOCK_ASSISTANT_RESPONSES.length)
        ];
      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: reply,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setIsTyping(false);
    }, delay);
  }, [input, isTyping]);

  return (
    <GlassCard className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <MessageSquare size={18} color="var(--primary)" />
          <div>
            <div className={styles.headerTitle}>MCP Console</div>
            <div className={styles.headerSub}>AI-powered media assistant</div>
          </div>
        </div>
        <div className={styles.statusRow}>
          <div className={styles.statusDot} />
          <span>Mock mode · Live chat arrives in Phase 2.3</span>
        </div>
      </div>

      <div className={styles.messages}>
        <MessageList messages={messages} isTyping={isTyping} />
      </div>

      <div className={styles.inputArea}>
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          disabled={isTyping}
        />
        <div className={styles.hint}>Press Enter to send · Shift+Enter for new line</div>
      </div>
    </GlassCard>
  );
}
