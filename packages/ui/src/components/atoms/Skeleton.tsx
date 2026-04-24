import styles from './Skeleton.module.css';

type SkeletonVariant = 'text-sm' | 'text-base' | 'text-lg' | 'text-xl' | 'block' | 'circle';

interface SkeletonProps {
  variant?: SkeletonVariant;
  width?:   string | number;
  height?:  string | number;
  className?: string;
  style?:   React.CSSProperties;
}

export function Skeleton({ variant = 'block', width, height, className, style }: SkeletonProps) {
  return (
    <div
      className={[styles.skeleton, styles[variant], className].filter(Boolean).join(' ')}
      style={{ width, height, ...style }}
    />
  );
}

interface WidgetLoadingOverlayProps {
  label?: string;
}

export function WidgetLoadingOverlay({ label = 'Loading…' }: WidgetLoadingOverlayProps) {
  return (
    <div className={styles.overlay}>
      <span className={styles.overlayText}>{label}</span>
    </div>
  );
}
