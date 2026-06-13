import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ProgressStepper.module.css";

export interface ProgressStepperStep {
  id: string;
  label: ReactNode;
}

export interface ProgressStepperProps {
  steps: ProgressStepperStep[];
  activeIndex: number;
  ariaLabel?: string;
  className?: string;
}

export function ProgressStepper({
  steps,
  activeIndex,
  ariaLabel = "Progress steps",
  className,
}: ProgressStepperProps) {
  return (
    <Stack
      as="ol"
      align="row"
      wrap
      gap="md"
      className={cn(styles.root, className)}
      aria-label={ariaLabel}
    >
      {steps.map((step, index) => (
        <li
          aria-current={index === activeIndex ? "step" : undefined}
          className={styles.item}
          data-active={index === activeIndex ? "true" : undefined}
          key={step.id}
        >
          <Typo.Caption as="span" className={styles.index}>
            {index + 1}
          </Typo.Caption>
          <Typo.Caption as="span" className={styles.label}>
            {step.label}
          </Typo.Caption>
        </li>
      ))}
    </Stack>
  );
}
