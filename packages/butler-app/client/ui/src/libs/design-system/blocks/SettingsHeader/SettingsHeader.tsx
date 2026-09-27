import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./SettingsHeader.module.css";
import { dsClass } from "../../lib/internal";

export interface SettingsHeaderProps extends DsPrivateStyleProps {
  title: ReactNode;
  description?: ReactNode;
  secondary?: ReactNode;
  action?: ReactNode;
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
      <Stack gap="xs" className={dsClass(styles.copy)}>
        <Typo.H2 as="h2" className={dsClass(styles.title)}>{title}</Typo.H2>
        {description ? (
          <Typo.Body className={dsClass(styles.description)}>{description}</Typo.Body>
        ) : null}
        {secondary ? (
          <div className={cn(styles.secondary, "no-drag")}>{secondary}</div>
        ) : null}
      </Stack>
      {action ? <div className={cn(styles.action, "no-drag")}>{action}</div> : null}
    </header>
  );
}
