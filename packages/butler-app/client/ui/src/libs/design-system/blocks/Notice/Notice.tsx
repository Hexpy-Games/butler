import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./Notice.module.css";
import { dsClass } from "../../lib/internal";

export interface NoticeProps extends DsPrivateStyleProps {
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
      className={dsClass(styles.notice, styles[`tone-${tone}`], className)}
    >
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <Stack gap="xs" className={dsClass(styles.message)}>
        {title && <Typo.Label as="span">{title}</Typo.Label>}
        <Typo.Body>{message}</Typo.Body>
      </Stack>
      {action && <div className={styles.action}>{action}</div>}
    </Stack>
  );
}
