import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./PanelHeader.module.css";

export interface PanelHeaderProps {
  /** Panel title */
  title: string;
  /** Optional description or subtitle */
  description?: string;
  /** Action buttons */
  actions?: ReactNode;
  /** Additional CSS class */
  className?: string;
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: PanelHeaderProps) {
  return (
    <Stack align="row" justify="between" cross="center" className={cn(styles.header, className)}>
      <Stack gap="xs" className={styles.text}>
        <Typo.PanelTitle className={styles.title}>{title}</Typo.PanelTitle>
        {description && (
          <Typo.Caption className={styles.description}>{description}</Typo.Caption>
        )}
      </Stack>
      {actions && <div className={styles.actions}>{actions}</div>}
    </Stack>
  );
}
