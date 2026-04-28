import { memo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './MessageBubble.module.css';
import { ToolCallChip } from './ToolCallChip';
import { ChoiceCards } from './ChoiceCards';
import { useToast } from '@/lib/toast';
import type { ChatMessage } from '@/lib/types';

interface MessageBubbleProps {
  message: ChatMessage;
  onPickChoice?: (messageId: string, choiceId: string) => void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onPickChoice,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const isUser = message.role === 'user';

  const bubbleClass = [
    styles.bubble,
    isUser ? styles.user : styles.assistant,
    message.isStreaming && !isUser ? styles.streaming : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleCopy = useCallback(async () => {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      toast(t('chat.copied'), 'success');
    } catch {
      toast(t('chat.copyFailed'), 'error');
    }
  }, [message.content, t, toast]);

  const tools = message.tools ?? [];
  const showTools = !isUser && tools.length > 0;

  return (
    <div className={[styles.wrapper, isUser ? styles.user : ''].filter(Boolean).join(' ')}>
      <div className={[styles.avatar, isUser ? styles.user : styles.assistant].join(' ')}>
        {isUser ? 'U' : 'M'}
      </div>

      <div className={styles.column}>
        <div className={bubbleClass}>
          {message.content ? (
            <BubbleContent content={message.content} isUser={isUser} />
          ) : null}
        </div>

        {showTools && (
          <div className={styles.toolStrip}>
            {tools.map(tc => (
              <ToolCallChip key={tc.callId} record={tc} />
            ))}
          </div>
        )}

        {!isUser && message.choices && message.choices.items.length > 0 && (
          <ChoiceCards
            prompt={message.choices.prompt}
            items={message.choices.items}
            onPick={(choiceId) => onPickChoice?.(message.id, choiceId)}
            disabled={message.isStreaming}
          />
        )}

        {/* Footer: timestamp + copy on assistant messages */}
        {!message.isStreaming && (
          <div className={[styles.footer, isUser ? styles.footerUser : ''].filter(Boolean).join(' ')}>
            {!isUser && message.content && (
              <button
                type="button"
                className={styles.copyBtn}
                onClick={handleCopy}
                title={t('chat.copy')}
                aria-label={t('chat.copy')}
              >
                <Copy size={12} />
              </button>
            )}
            <span className={styles.timestamp}>{formatTime(message.timestamp)}</span>
          </div>
        )}
      </div>
    </div>
  );
});

interface BubbleContentProps {
  content: string;
  isUser:  boolean;
}

/** GitHub-flavored markdown rendering. Tables, lists, code blocks, links.
 *  User messages skip markdown — they're plain user input, less surprise that way. */
function BubbleContent({ content, isUser }: BubbleContentProps) {
  if (isUser) {
    return <span className={styles.plainUserText}>{content}</span>;
  }
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          // react-markdown's default <code> handles both inline and fenced.
          // CSS in MessageBubble.module.css targets `.markdown code` and
          // `.markdown pre code` separately for inline vs block styling.
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
