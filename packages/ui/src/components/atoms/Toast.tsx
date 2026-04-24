import { CheckCircle, XCircle, Info } from 'lucide-react';
import styles from './Toast.module.css';
import type { ToastItem } from '@/lib/toast';

const ICON = { success: CheckCircle, error: XCircle, info: Info };

export function ToastStack({ toasts }: { toasts: ToastItem[] }) {
  if (!toasts.length) return null;
  return (
    <div className={styles.container}>
      {toasts.map(t => {
        const Icon = ICON[t.type];
        return (
          <div key={t.id} className={`${styles.toast} ${styles[t.type]}`}>
            <Icon size={15} />
            <span>{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}
