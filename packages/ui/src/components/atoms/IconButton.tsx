import styles from './IconButton.module.css';

interface IconButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  size?: 'md' | 'lg';
  title?: string;
  className?: string;
}

export function IconButton({
  children,
  onClick,
  active = false,
  size = 'md',
  title,
  className,
}: IconButtonProps) {
  const classes = [
    styles.btn,
    active && styles.active,
    size === 'lg' && styles.lg,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} onClick={onClick} title={title} type="button">
      {children}
    </button>
  );
}
