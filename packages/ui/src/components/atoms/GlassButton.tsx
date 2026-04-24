import styles from './GlassButton.module.css';

type Variant = 'primary' | 'secondary';
type Size = 'sm' | 'md' | 'lg';

interface GlassButtonProps {
  children: React.ReactNode;
  variant?: Variant;
  size?: Size;
  iconOnly?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}

export function GlassButton({
  children,
  variant = 'primary',
  size = 'md',
  iconOnly = false,
  onClick,
  disabled = false,
  type = 'button',
  className,
}: GlassButtonProps) {
  const classes = [
    styles.btn,
    styles[variant],
    size !== 'md' && styles[size],
    iconOnly && styles.iconOnly,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={classes}
      onClick={onClick}
      disabled={disabled}
      type={type}
      style={{ opacity: disabled ? 0.4 : 1, pointerEvents: disabled ? 'none' : undefined }}
    >
      {children}
    </button>
  );
}
