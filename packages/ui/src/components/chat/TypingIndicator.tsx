import styles from './TypingIndicator.module.css';

export function TypingIndicator() {
  return (
    <div className={styles.wrapper}>
      <div className={styles.avatar}>M</div>
      <div className={styles.bubble}>
        <div className={styles.dot} />
        <div className={styles.dot} />
        <div className={styles.dot} />
      </div>
    </div>
  );
}
