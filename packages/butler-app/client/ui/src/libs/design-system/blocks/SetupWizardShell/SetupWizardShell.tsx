import type { HTMLAttributes, ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { TintedGlass } from "../../components/TintedGlass";
import { ScrollArea } from "../ScrollArea";
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
  windowControls?: ReactNode;
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
  windowControls,
  ...props
}: SetupWizardShellProps) {
  const regionLabel = typeof title === "string" ? title : undefined;

  return (
    <main className={styles.screen} {...props}>
      <PromptFluidBackground variant="bloom" />
      <div
        aria-hidden="true"
        className={`${styles.dragLane} drag-region`}
        data-test-class="setup-wizard-drag-lane"
      />
      {windowControls ? (
        <div className={`${styles.windowControls} no-drag`}>
          {windowControls}
        </div>
      ) : null}
      <Stack
        as="section"
        className={styles.shell}
        gap="lg"
        aria-label={regionLabel}
      >
        <Stack className={`${styles.header} drag-region`} gap="sm">
          <p className={styles.productTitle}>{title}</p>
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
          <ScrollArea
            className={styles.scrollArea}
            contentClassName={styles.scrollContent}
            dataTestClass="setup-wizard-scroll"
          >
            {children}
          </ScrollArea>
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
