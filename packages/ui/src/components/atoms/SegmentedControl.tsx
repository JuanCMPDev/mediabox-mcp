import styles from './SegmentedControl.module.css';

interface Option {
  value: string;
  label: string;
}

interface SegmentedControlProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps) {
  return (
    <div className={[styles.track, className].filter(Boolean).join(' ')}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={[styles.option, value === opt.value && styles.active]
            .filter(Boolean)
            .join(' ')}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
