import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./SettingsHeader.module.css";

export interface SettingsHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  secondary?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function SettingsHeader({
  title,
  description,
  secondary,
  action,
  className,
}: SettingsHeaderProps) {
  return (
    <header className={cn(styles.header, className)}>
      <Stack gap="xs" className={styles.copy}>
        <Typo.PanelTitle className={styles.title}>{title}</Typo.PanelTitle>
        {description ? (
          <Typo.Body className={styles.description}>{description}</Typo.Body>
        ) : null}
        {secondary ? (
          <div className={cn(styles.secondary, "no-drag")}>{secondary}</div>
        ) : null}
      </Stack>
      {action ? <div className={cn(styles.action, "no-drag")}>{action}</div> : null}
    </header>
  );
}
