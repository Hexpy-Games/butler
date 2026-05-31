import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./Notice.module.css";

export interface NoticeProps {
  /** Visual tone */
  tone: "info" | "warning" | "error" | "success";
  /** Icon element */
  icon?: ReactNode;
  /** Optional notice title */
  title?: ReactNode;
  /** Notice message */
  message: ReactNode;
  /** Optional action button */
  action?: ReactNode;
  /** Additional CSS class */
  className?: string;
}

export function Notice({
  tone,
  icon,
  title,
  message,
  action,
  className,
}: NoticeProps) {
  return (
    <Stack
      align="row"
      gap="sm"
      cross="center"
      className={cn(styles.notice, styles[`tone-${tone}`], className)}
    >
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <Stack gap="xs" className={styles.message}>
        {title && <Typo.Label as="span">{title}</Typo.Label>}
        <Typo.Body>{message}</Typo.Body>
      </Stack>
      {action && <div className={styles.action}>{action}</div>}
    </Stack>
  );
}
