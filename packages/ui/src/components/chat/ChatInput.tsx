import { SendHorizonal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './ChatInput.module.css';
import { GlassInput } from '@/components/atoms/GlassInput';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
}

export function ChatInput({ value, onChange, onSend, disabled = false }: ChatInputProps) {
  const { t } = useTranslation();

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey && value.trim()) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <div className={styles.row}>
      <GlassInput
        className={styles.input}
        value={value}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        placeholder={t('chat.askPlaceholder')}
        disabled={disabled}
        autoFocus
      />
      <button
        className={styles.sendBtn}
        type="button"
        onClick={onSend}
        disabled={disabled || !value.trim()}
        title={t('chat.send')}
      >
        <SendHorizonal size={18} />
      </button>
    </div>
  );
}
