import { MessageSquare, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './ChatPanel.module.css';
import { GlassCard }       from '@/components/atoms/GlassCard';
import { MessageList }     from './MessageList';
import { ChatInput }       from './ChatInput';
import { useChat }         from '@/lib/use-chat';
import { useState }        from 'react';

export function ChatPanel() {
  const { t } = useTranslation();
  const { messages, isStreaming, send, pickChoice, clear } = useChat();
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
              {t('chat.title')}
              <span className={styles.betaBadge}>Beta</span>
            </div>
            <div className={styles.headerSub}>
              {t('chat.subtitle')}
            </div>
          </div>
        </div>

        <div className={styles.headerRight}>
          {confirmClear ? (
            <div className={styles.confirmRow}>
              <span className={styles.confirmLabel}>{t('chat.clearConfirm')}</span>
              <button className={styles.confirmYes} onClick={handleClear}>{t('chat.yes')}</button>
              <button className={styles.confirmNo}  onClick={() => setConfirmClear(false)}>{t('chat.no')}</button>
            </div>
          ) : (
            <button
              className={styles.clearBtn}
              onClick={() => setConfirmClear(true)}
              title={t('chat.clearTitle')}
              disabled={messages.length === 0}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className={styles.messages}>
        <MessageList messages={messages} isTyping={false} onPickChoice={pickChoice} />
      </div>

      {/* Input */}
      <div className={styles.inputArea}>
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          disabled={isStreaming}
        />
        <div className={styles.hint}>
          {isStreaming ? t('chat.generating') : t('chat.pressEnterMultiline')}
        </div>
      </div>
    </GlassCard>
  );
}
