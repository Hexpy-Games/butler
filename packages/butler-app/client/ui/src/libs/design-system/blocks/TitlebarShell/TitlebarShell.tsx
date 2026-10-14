import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { IconButton } from "../../components/IconButton";
import { ArrowLeft } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./TitlebarShell.module.css";
import { dsClass } from "../../lib/internal";

/** Up one level from a nested screen (서랍 › 스크랩 › 여행): a back button at the title's start. */
export interface TitlebarBack {
  /** “Back to Scraps” / “스크랩으로 돌아가기”; also the tooltip. */
  label: string;
  onBack: () => void;
}

export interface TitlebarShellProps extends DsPrivateStyleProps {
  title: ReactNode;
  /** Shown on nested screens only; top-level screens pass nothing. The App binds ⌘[ / Alt+← to the same action. */
  back?: TitlebarBack;
  subtitle?: ReactNode;
  leading?: ReactNode;
  leadingVisibility?: "always" | "narrow";
  /** `glyph` (default): a square the size of the title line. `auto`: the control keeps its own size (a conversation button). */
  leadingSize?: "glyph" | "auto";
  trailing?: ReactNode;
  windowControls?: ReactNode;
  collapsed?: boolean;
  /** Makes the titlebar a window drag region (controls inside it stay clickable). */
  dragRegion?: boolean;
  dataTestClass?: string;
}

export function TitlebarShell({
  title,
  back,
  subtitle,
  leading,
  leadingVisibility = "always",
  leadingSize = "glyph",
  trailing,
  windowControls,
  collapsed = false,
  dragRegion = false,
  className,
  dataTestClass,
}: TitlebarShellProps) {
  return (
    <header
      className={cn(styles.titlebar, collapsed && styles.collapsed, dragRegion && "drag-region", className)}
      data-test-class={dataTestClass}
    >
      <Stack align="row" cross="center" gap="sm" className={dsClass(styles.identity)}>
        {back ? (
          <span className={cn(styles.back, "no-drag")} data-slot="titlebar-back">
            <IconButton label={back.label} onClick={back.onBack} data-test-class="titlebar-back">
              <ArrowLeft size="md" />
            </IconButton>
          </span>
        ) : null}
        {leading ? (
          <span
            className={styles.leading}
            data-slot="titlebar-leading"
            data-visibility={leadingVisibility}
            data-size={leadingSize === "auto" ? "auto" : undefined}
          >
            {leading}
          </span>
        ) : null}
        <div className={styles.copy}>
          <Typo.AppTitle className={dsClass(styles.title)} data-slot="titlebar-title">
            {title}
          </Typo.AppTitle>
          {subtitle ? (
            <Typo.Caption className={dsClass(styles.subtitle)}>{subtitle}</Typo.Caption>
          ) : null}
        </div>
      </Stack>
      {trailing ? (
        <div className={cn(styles.trailing, "no-drag")}>{trailing}</div>
      ) : null}
      {windowControls ? (
        <div className={cn(styles.windowControls, "no-drag")}>
          {windowControls}
        </div>
      ) : null}
    </header>
  );
}
