import styles from './MessageBubble.module.css';
import type { ChatMessage } from '@/lib/types';

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={[styles.wrapper, isUser ? styles.user : ''].filter(Boolean).join(' ')}>
      <div className={[styles.avatar, isUser ? styles.user : styles.assistant].join(' ')}>
        {isUser ? 'U' : 'M'}
      </div>
      <div className={[styles.bubble, isUser ? styles.user : styles.assistant].join(' ')}>
        <BubbleContent content={message.content} />
      </div>
      <span className={styles.timestamp}>{formatTime(message.timestamp)}</span>
    </div>
  );
}

function BubbleContent({ content }: { content: string }) {
  // Basic markdown: **bold** support
  const parts = content.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
