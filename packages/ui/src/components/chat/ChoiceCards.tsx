import { ChevronRight } from 'lucide-react';
import styles from './ChoiceCards.module.css';
import type { ChatChoiceItem } from '@/lib/types';

interface ChoiceCardsProps {
  prompt?: string;
  items:   ChatChoiceItem[];
  onPick:  (choiceId: string) => void;
  disabled?: boolean;
}

/** Clickable cards rendered when the assistant emits a `choices` event.
 *  Each click sends the item's `value` back as the next user message — the
 *  cards then disappear (use-chat clears `choices` on the message). */
export function ChoiceCards({ prompt, items, onPick, disabled = false }: ChoiceCardsProps) {
  return (
    <div className={styles.wrapper}>
      {prompt && <div className={styles.prompt}>{prompt}</div>}
      <div className={styles.grid}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={styles.card}
            onClick={() => onPick(item.id)}
            disabled={disabled}
          >
            <div className={styles.cardBody}>
              <div className={styles.label}>{item.label}</div>
              {item.subtitle && <div className={styles.subtitle}>{item.subtitle}</div>}
              {item.meta     && <div className={styles.meta}>{item.meta}</div>}
            </div>
            <ChevronRight size={16} className={styles.chevron} />
          </button>
        ))}
      </div>
    </div>
  );
}
