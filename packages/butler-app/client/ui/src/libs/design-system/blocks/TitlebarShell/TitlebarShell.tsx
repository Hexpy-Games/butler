import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./TitlebarShell.module.css";
import { dsClass } from "../../lib/internal";

export interface TitlebarShellProps extends DsPrivateStyleProps {
  title: ReactNode;
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
