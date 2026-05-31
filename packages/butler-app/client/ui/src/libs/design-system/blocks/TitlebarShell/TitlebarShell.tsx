import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./TitlebarShell.module.css";

export interface TitlebarShellProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  leadingVisibility?: "always" | "narrow";
  trailing?: ReactNode;
  collapsed?: boolean;
  className?: string;
  dataTestClass?: string;
}

export function TitlebarShell({
  title,
  subtitle,
  leading,
  leadingVisibility = "always",
  trailing,
  collapsed = false,
  className,
  dataTestClass,
}: TitlebarShellProps) {
  return (
    <header
      className={cn(styles.titlebar, collapsed && styles.collapsed, className)}
      data-test-class={dataTestClass}
    >
      <Stack align="row" cross="center" gap="sm" className={styles.identity}>
        {leading ? (
          <span
            className={styles.leading}
            data-slot="titlebar-leading"
            data-visibility={leadingVisibility}
          >
            {leading}
          </span>
        ) : null}
        <div className={styles.copy}>
          <Typo.AppTitle className={styles.title} data-slot="titlebar-title">
            {title}
          </Typo.AppTitle>
          {subtitle ? (
            <Typo.Caption className={styles.subtitle}>{subtitle}</Typo.Caption>
          ) : null}
        </div>
      </Stack>
      {trailing ? (
        <div className={cn(styles.trailing, "no-drag")}>{trailing}</div>
      ) : null}
    </header>
  );
}
