import styles from './GlassInput.module.css';

interface GlassInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  type?: 'text' | 'password' | 'email' | 'number';
}

export function GlassInput({
  value,
  onChange,
  placeholder,
  iconLeft,
  iconRight,
  onKeyDown,
  disabled = false,
  autoFocus = false,
  className,
  type = 'text',
}: GlassInputProps) {
  return (
    <div className={[styles.wrapper, className].filter(Boolean).join(' ')}>
      {iconLeft && <span className={styles.icon}>{iconLeft}</span>}
      <input
        className={styles.input}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onKeyDown={onKeyDown}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      {iconRight && <span className={styles.icon}>{iconRight}</span>}
    </div>
  );
}
