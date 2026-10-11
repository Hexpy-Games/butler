import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { PageContainer } from "../../components/PageContainer";
import { Stack } from "../../components/Stack";
import { TintedGlass } from "../../components/TintedGlass";
import { ScrollArea } from "../ScrollArea";
import { SetupWizardProgress, type SetupWizardStep } from "./SetupWizardProgress";
import { Wallpaper, type WallpaperSource } from "../Wallpaper";
import { SetupWizardStage, type SetupWizardIntro } from "./SetupWizardStage";
import { useSetupIntro } from "./useSetupIntro";
import styles from "./SetupWizardShell.module.css";
import introStyles from "./SetupWizardIntro.module.css";
import { dsClass } from "../../lib/internal";

export { SetupWizardProgress, type SetupWizardProgressProps, type SetupWizardStep } from "./SetupWizardProgress";
export { SetupWizardContent, SetupWizardList, type SetupWizardContentProps } from "./SetupWizardContent";
export type { SetupWizardIntro } from "./SetupWizardStage";
export { SetupWizardMark, type SetupWizardMarkProps } from "./SetupWizardMark";

/**
 * The first-run backdrop is the riso print, whatever the user's wallpaper. The
 * first-install ink intro (`intro="full"`) draws on this layer and reads the
 * card morph's rects (`SetupWizardMorph.from/to`) for its keep-out.
 */
const SETUP_WALLPAPER: WallpaperSource = { kind: "live", module: "butler.riso-print" };

/** `wizard`: title, stepper and a glass body. `focus`: one centered column on the backdrop. */
export type SetupWizardVariant = "wizard" | "focus";

/** Focus only. `center`: the column sits in the middle of the window. `top`: every screen shares one top edge. */
export type SetupWizardAnchor = "center" | "top";

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
  /** Focus only: where the column sits (default `center`). */
  anchor?: SetupWizardAnchor;
  /**
   * Focus only: a new key replaces the card. A width change (420px intro and
   * 520px step) morphs one card into the other; otherwise the old card fades
   * out and the new one rises in.
   */
  stepKey?: string;
  /** Focus only: how the first card appears (`full`: the ink intro, `rerun`: the short re-run variant). */
  intro?: SetupWizardIntro;
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
  anchor = "center",
  stepKey,
  intro,
  ...props
}: SetupWizardShellProps) {
  const regionLabel = typeof title === "string" ? title : undefined;
  const { timeline, wash } = useSetupIntro(variant === "focus" ? intro : undefined);

  return (
    <main
      className={styles.screen}
      data-anchor={variant === "focus" ? anchor : undefined}
      data-embedded={embedded ? "true" : undefined}
      data-tone={tone}
      data-variant={variant}
      {...props}
    >
      <Wallpaper intro={timeline} source={SETUP_WALLPAPER} tone={tone} />
      {wash ? <div aria-hidden="true" className={introStyles.wash} data-test-class="setup-intro-wash" /> : null}
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
            {stepKey === undefined && intro === undefined ? children
              : <SetupWizardStage intro={intro} stepKey={stepKey ?? "card"} timeline={timeline}>{children}</SetupWizardStage>}
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
