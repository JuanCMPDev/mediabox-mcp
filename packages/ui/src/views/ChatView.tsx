import styles from './ChatView.module.css';
import { ChatPanel } from '@/components/chat/ChatPanel';

export function ChatView() {
  return (
    <div className={styles.view}>
      <div className={styles.panel}>
        <ChatPanel />
      </div>
    </div>
  );
}
