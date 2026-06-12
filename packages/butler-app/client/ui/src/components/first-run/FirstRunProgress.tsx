import styles from "./FirstRunSetup.module.css";

interface FirstRunProgressProps {
  activeIndex: number;
  labels: readonly string[];
}

export function FirstRunProgress({
  activeIndex,
  labels,
}: FirstRunProgressProps) {
  return (
    <div className={styles.steps} aria-label="First-run setup steps">
      {labels.map((label, index) => (
        <span
          className={index === activeIndex ? styles.stepActive : styles.step}
          key={label}
        >
          {label}
        </span>
      ))}
    </div>
  );
}
