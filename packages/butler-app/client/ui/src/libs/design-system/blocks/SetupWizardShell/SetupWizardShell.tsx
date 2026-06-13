import type { HTMLAttributes, ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { TintedGlass } from "../../components/TintedGlass";
import { Typo } from "../../components/Typo";
import { ProgressStepper, type ProgressStepperStep } from "../ProgressStepper";
import { PromptFluidBackground } from "../PromptSuggestionList/PromptFluidBackground";
import styles from "./SetupWizardShell.module.css";

interface SetupWizardShellProps
  extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  activeIndex: number;
  children: ReactNode;
  steps: ProgressStepperStep[];
  title: ReactNode;
  progressLabel?: string;
}

interface SetupWizardContentProps {
  children: ReactNode;
  width?: "default" | "wide";
}

export function SetupWizardShell({
  activeIndex,
  children,
  progressLabel,
  steps,
  title,
  ...props
}: SetupWizardShellProps) {
  const regionLabel = typeof title === "string" ? title : undefined;

  return (
    <main className={styles.screen} {...props}>
      <PromptFluidBackground variant="bloom" />
      <Stack
        as="section"
        className={styles.shell}
        gap="lg"
        aria-label={regionLabel}
      >
        <Stack className={styles.header} gap="sm">
          <Typo.AppTitle as="p">{title}</Typo.AppTitle>
          <ProgressStepper
            activeIndex={activeIndex}
            ariaLabel={progressLabel}
            steps={steps}
          />
        </Stack>
        <TintedGlass
          as="section"
          className={styles.body}
          padding="lg"
          radius="panel"
        >
          {children}
        </TintedGlass>
      </Stack>
    </main>
  );
}

export function SetupWizardContent({
  children,
  width = "default",
}: SetupWizardContentProps) {
  return (
    <Stack className={styles.content} data-width={width} gap="lg">
      {children}
    </Stack>
  );
}

export function SetupWizardList({ children }: SetupWizardContentProps) {
  return (
    <Stack as="ul" className={styles.list} gap="sm">
      {children}
    </Stack>
  );
}
