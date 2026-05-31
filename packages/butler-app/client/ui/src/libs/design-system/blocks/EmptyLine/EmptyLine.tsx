import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./EmptyLine.module.css";

export interface EmptyLineProps {
  /** Icon element */
  icon?: ReactNode;
  /** Empty state message */
  message: string;
  /** Optional action button */
  action?: ReactNode;
  /** Additional CSS class */
  className?: string;
}

export function EmptyLine({
  icon,
  message,
  action,
  className,
}: EmptyLineProps) {
  return (
    <Stack gap="md" cross="center" className={cn(styles.empty, className)}>
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <Typo.Body className={styles.message}>{message}</Typo.Body>
      {action && <div className={styles.action}>{action}</div>}
    </Stack>
  );
}
