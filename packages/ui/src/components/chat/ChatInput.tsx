import { useEffect, useRef } from 'react';
import { SendHorizonal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './ChatInput.module.css';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
}

const MAX_HEIGHT_PX = 180;

export function ChatInput({ value, onChange, onSend, disabled = false }: ChatInputProps) {
  const { t } = useTranslation();
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: reset to auto, then set height to scrollHeight (capped). Runs
  // on every value change so the textarea expands as the user types and
  // shrinks back when they delete lines.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.min(ta.scrollHeight, MAX_HEIGHT_PX);
    ta.style.height = `${next}px`;
  }, [value]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline (default textarea behavior,
    // we just don't preventDefault). IME composition events use keyCode 229
    // — don't fire send mid-composition (Japanese, Chinese, etc.).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (!value.trim()) return;
      e.preventDefault();
      onSend();
    }
  }

  return (
    <div className={styles.row}>
      <div className={styles.inputWrap}>
        <textarea
          ref={taRef}
          className={styles.input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('chat.askPlaceholder')}
          disabled={disabled}
          autoFocus
          rows={1}
        />
      </div>
      <button
        className={styles.sendBtn}
        type="button"
        onClick={onSend}
        disabled={disabled || !value.trim()}
        title={t('chat.send')}
        aria-label={t('chat.send')}
      >
        <SendHorizonal size={18} />
      </button>
    </div>
  );
}
