import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { PageContainer } from "../../components/PageContainer";
import { Stack } from "../../components/Stack";
import { TintedGlass } from "../../components/TintedGlass";
import { ScrollArea } from "../ScrollArea";
import { SetupWizardProgress, type SetupWizardStep } from "./SetupWizardProgress";
import { Wallpaper, type WallpaperSource } from "../Wallpaper";
import styles from "./SetupWizardShell.module.css";
import { dsClass } from "../../lib/internal";

export type { SetupWizardStep } from "./SetupWizardProgress";

/** The first-run backdrop stays bloom, whatever the user's wallpaper. */
const SETUP_WALLPAPER: WallpaperSource = { kind: "live", module: "butler.bloom" };

/** `wizard`: title, stepper and a glass body. `focus`: one centered column on the backdrop. */
export type SetupWizardVariant = "wizard" | "focus";

interface SetupWizardShellProps
  extends Omit<DsBaseProps<HTMLAttributes<HTMLElement>>, "title"> {
  children: ReactNode;
  /** Visible product title (wizard); the region's accessible name in both variants. */
  title: ReactNode;
  variant?: SetupWizardVariant;
  /** Wizard steps; the stepper shows only when steps are given. */
  steps?: SetupWizardStep[];
  activeIndex?: number;
  progressLabel?: string;
  windowControls?: ReactNode;
  /** Resolved appearance theme for the wallpaper backdrop. */
  tone?: "light" | "dark";
  /** Contain the full-screen layers in the element (DS Viewer previews). */
  embedded?: boolean;
}

interface SetupWizardContentProps {
  children: ReactNode;
  /** Wizard: `default` 52ch, `wide` the full body. Focus: `default` 420px, `wide` 520px. */
  width?: "default" | "wide";
}

export function SetupWizardShell({
  activeIndex = 0,
  children,
  progressLabel,
  steps,
  title,
  variant = "wizard",
  windowControls,
  tone = "light",
  embedded = false,
  ...props
}: SetupWizardShellProps) {
  const regionLabel = typeof title === "string" ? title : undefined;

  return (
    <main
      className={styles.screen}
      data-embedded={embedded ? "true" : undefined}
      data-tone={tone}
      data-variant={variant}
      {...props}
    >
      <Wallpaper source={SETUP_WALLPAPER} tone={tone} />
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
      {variant === "focus" ? (
        <ScrollArea
          className={dsClass(styles.focusScroll)}
          contentClassName={dsClass(styles.focusScrollContent)}
          dataTestClass="setup-wizard-scroll"
        >
          <PageContainer
            as="section"
            width="narrow"
            gutter="none"
            className={dsClass(styles.focusColumn)}
            aria-label={regionLabel}
          >
            {children}
          </PageContainer>
        </ScrollArea>
      ) : (
        <PageContainer
          as="section"
          width="narrow"
          gutter="none"
          className={dsClass(styles.shell)}
          aria-label={regionLabel}
        >
          <Stack className={dsClass(`${styles.header} drag-region`)} gap="sm">
            <p className={styles.productTitle}>{title}</p>
            {steps ? (
              <SetupWizardProgress
                activeIndex={activeIndex}
                ariaLabel={progressLabel}
                steps={steps}
              />
            ) : null}
          </Stack>
          <TintedGlass
            as="section"
            className={dsClass(styles.body)}
            padding="none"
            radius="panel"
          >
            <ScrollArea
              className={dsClass(styles.scrollArea)}
              contentClassName={dsClass(styles.scrollContent)}
              dataTestClass="setup-wizard-scroll"
            >
              {children}
            </ScrollArea>
          </TintedGlass>
        </PageContainer>
      )}
    </main>
  );
}

export function SetupWizardContent({
  children,
  width = "default",
}: SetupWizardContentProps) {
  return (
    <Stack className={dsClass(styles.content)} data-width={width} gap="lg">
      {children}
    </Stack>
  );
}

export function SetupWizardList({ children }: SetupWizardContentProps) {
  return (
    <Stack as="ul" className={dsClass(styles.list)} gap="sm">
      {children}
    </Stack>
  );
}
