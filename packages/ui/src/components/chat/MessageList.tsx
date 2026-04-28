import { useEffect, useRef } from 'react';
import styles from './MessageList.module.css';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';
import type { ChatMessage } from '@/lib/types';

interface MessageListProps {
  messages: ChatMessage[];
  isTyping: boolean;
  onPickChoice?: (messageId: string, choiceId: string) => void;
}

export function MessageList({ messages, isTyping, onPickChoice }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Re-scroll on (a) new messages, (b) typing indicator toggle, and (c) the
  // streaming bubble growing — otherwise long replies would scroll past the
  // viewport bottom without the list following.
  const last = messages[messages.length - 1];
  const lastContentLen = last?.content.length ?? 0;
  const lastToolsLen   = last?.tools?.length ?? 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isTyping, lastContentLen, lastToolsLen]);

  return (
    <div className={styles.list}>
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} onPickChoice={onPickChoice} />
      ))}
      {isTyping && <TypingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
