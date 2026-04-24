import styles from './AtmosphericBackground.module.css';

export function AtmosphericBackground() {
  return (
    <div className={styles.container} aria-hidden="true">
      <div className={`${styles.orb} ${styles.orb1}`} />
      <div className={`${styles.orb} ${styles.orb2}`} />
      <div className={`${styles.orb} ${styles.orb3}`} />
      <div className={`${styles.orb} ${styles.orb4}`} />
    </div>
  );
}
