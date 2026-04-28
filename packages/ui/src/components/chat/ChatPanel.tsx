import { MessageSquare, Trash2 } from 'lucide-react';
import styles from './ChatPanel.module.css';
import { GlassCard }       from '@/components/atoms/GlassCard';
import { MessageList }     from './MessageList';
import { ChatInput }       from './ChatInput';
import { ActiveToolChip }  from './ActiveToolChip';
import { useChat }         from '@/lib/use-chat';
import { useState }        from 'react';

export function ChatPanel() {
  const { messages, isStreaming, activeTool, send, clear } = useChat();
  const [input, setInput] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  async function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    await send(text);
  }

  async function handleClear() {
    setConfirmClear(false);
    await clear();
  }

  return (
    <GlassCard className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <MessageSquare size={18} color="var(--primary)" />
          <div>
            <div className={styles.headerTitle}>
              MCP Console
              <span className={styles.betaBadge}>Beta</span>
            </div>
            <div className={styles.headerSub}>
              AI-powered media assistant — early preview, may misfire on complex requests.
            </div>
          </div>
        </div>

        <div className={styles.headerRight}>
          {confirmClear ? (
            <div className={styles.confirmRow}>
              <span className={styles.confirmLabel}>Clear conversation?</span>
              <button className={styles.confirmYes} onClick={handleClear}>Yes</button>
              <button className={styles.confirmNo}  onClick={() => setConfirmClear(false)}>No</button>
            </div>
          ) : (
            <button
              className={styles.clearBtn}
              onClick={() => setConfirmClear(true)}
              title="Clear conversation"
              disabled={messages.length === 0}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className={styles.messages}>
        <MessageList messages={messages} isTyping={false} />
      </div>

      {/* Tool progress chip */}
      {activeTool && (
        <div className={styles.toolRow}>
          <ActiveToolChip name={activeTool} />
        </div>
      )}

      {/* Input */}
      <div className={styles.inputArea}>
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          disabled={isStreaming}
        />
        <div className={styles.hint}>
          {isStreaming ? 'Generating…' : 'Press Enter to send'}
        </div>
      </div>
    </GlassCard>
  );
}
