import styles from './GlassCard.module.css';

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  level?: 2 | 3;
  noPadding?: boolean;
  interactive?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}

export function GlassCard({
  children,
  className,
  level = 2,
  noPadding = false,
  interactive = false,
  onClick,
  style,
}: GlassCardProps) {
  const classes = [
    styles.card,
    level === 3 && styles.level3,
    noPadding && styles.noPadding,
    interactive && styles.interactive,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} onClick={onClick} style={style}>
      {children}
    </div>
  );
}
