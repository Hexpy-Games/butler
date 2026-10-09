import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { IconSlot } from "../../components/IconSlot";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./Notice.module.css";
import { dsClass } from "../../lib/internal";

export type NoticeTone = "neutral" | "info" | "warning" | "error" | "success";

export interface NoticeProps extends DsPrivateStyleProps {
  /** Visual tone; `neutral` is a quiet muted status (waiting, account) with no color meaning. */
  tone: NoticeTone;
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
      cross="start"
      className={dsClass(styles.notice, styles[`tone-${tone}`], className)}
    >
      <Stack align="row" cross="start" gap="sm" grow minWidth="0">
        {icon && <IconSlot size="md" minHeight="line" className={dsClass(styles.icon)} aria-hidden="true">{icon}</IconSlot>}
        <Stack gap="xs" className={dsClass(styles.message)}>
          {title && <Typo.Label as="span" className={dsClass(styles.title)}>{title}</Typo.Label>}
          <Typo.Body>{message}</Typo.Body>
        </Stack>
      </Stack>
      {action && <div className={styles.action}>{action}</div>}
    </Stack>
  );
}
