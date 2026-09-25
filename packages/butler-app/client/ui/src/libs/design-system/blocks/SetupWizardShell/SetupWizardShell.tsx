import type { HTMLAttributes, ReactNode } from "react";
import { PageContainer } from "../../components/PageContainer";
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
  /** Resolved appearance theme for the fluid backdrop. */
  tone?: "light" | "dark";
  /** Contain the full-screen layers in the element (DS Viewer previews). */
  embedded?: boolean;
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
  tone = "light",
  embedded = false,
  ...props
}: SetupWizardShellProps) {
  const regionLabel = typeof title === "string" ? title : undefined;

  return (
    <main className={styles.screen} data-tone={tone} data-embedded={embedded ? "true" : undefined} {...props}>
      <PromptFluidBackground variant="bloom" tone={tone} />
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
      <PageContainer
        as="section"
        width="narrow"
        gutter="none"
        className={styles.shell}
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
          padding="none"
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
      </PageContainer>
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
