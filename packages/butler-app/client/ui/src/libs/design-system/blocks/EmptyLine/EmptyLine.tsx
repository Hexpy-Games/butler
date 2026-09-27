import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./EmptyLine.module.css";
import { dsClass } from "../../lib/internal";

export interface EmptyLineProps extends DsPrivateStyleProps {
  /** Icon element */
  icon?: ReactNode;
  /** Empty state message */
  message: string;
  /** Optional action button */
  action?: ReactNode;
}

export function EmptyLine({
  icon,
  message,
  action,
  className,
}: EmptyLineProps) {
  return (
    <Stack gap="md" cross="center" className={dsClass(styles.empty, className)}>
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <Typo.Body className={dsClass(styles.message)}>{message}</Typo.Body>
      {action && <div className={styles.action}>{action}</div>}
    </Stack>
  );
}
