interface FirstRunProgressProps {
  activeIndex: number;
  labels: readonly string[];
}

export function FirstRunProgress({
  activeIndex,
  labels,
}: FirstRunProgressProps) {
  return (
    <div className="first-run-setup-steps" aria-label="First-run setup steps">
      {labels.map((label, index) => (
        <span
          className={
            index === activeIndex
              ? "first-run-setup-step-active"
              : "first-run-setup-step"
          }
          key={label}
        >
          {label}
        </span>
      ))}
    </div>
  );
}
