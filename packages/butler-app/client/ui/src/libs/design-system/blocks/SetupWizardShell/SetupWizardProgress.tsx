import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./SetupWizardProgress.module.css";
import { dsClass } from "../../lib/internal";

export interface SetupWizardStep {
  id: string;
  label: ReactNode;
}

export interface SetupWizardProgressProps extends DsPrivateStyleProps {
  steps: SetupWizardStep[];
  activeIndex: number;
  ariaLabel?: string;
}

export function SetupWizardProgress({
  steps,
  activeIndex,
  ariaLabel = "Progress steps",
  className,
}: SetupWizardProgressProps) {
  return (
    <Stack
      as="ol"
      align="row"
      wrap
      gap="md"
      className={dsClass(styles.root, className)}
      aria-label={ariaLabel}
    >
      {steps.map((step, index) => (
        <li
          aria-current={index === activeIndex ? "step" : undefined}
          className={styles.item}
          data-active={index === activeIndex ? "true" : undefined}
          key={step.id}
        >
          <Typo.Caption as="span" className={dsClass(styles.index)}>
            {index + 1}
          </Typo.Caption>
          <Typo.Caption as="span" className={dsClass(styles.label)}>
            {step.label}
          </Typo.Caption>
        </li>
      ))}
    </Stack>
  );
}
