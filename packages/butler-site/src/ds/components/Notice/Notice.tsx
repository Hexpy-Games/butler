import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { AlertTriangle, CheckCircle, CircleX, Info } from "../Icons";
import { Typo } from "../Typo";
import styles from "./Notice.module.css";

export type NoticeTone = "info" | "warning" | "error" | "success";

export interface NoticeProps {
  tone: NoticeTone;
  /** Overrides the tone's default icon. */
  icon?: ReactNode;
  title?: ReactNode;
  /** Short message; use children for rich content (links, code, lists). */
  message?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}

const TONE_ICON: Record<NoticeTone, ReactNode> = {
  info: <Info />,
  warning: <AlertTriangle />,
  error: <CircleX />,
  success: <CheckCircle />,
};

export function Notice({ tone, icon, title, message, children, action }: NoticeProps) {
  return (
    <div className={cn(styles.notice, styles[`tone-${tone}`])} data-slot="notice" role={tone === "error" ? "alert" : "note"}>
      <span className={styles.icon} aria-hidden="true">{icon ?? TONE_ICON[tone]}</span>
      <div className={styles.message}>
        {title ? <Typo.Label weight="semibold">{title}</Typo.Label> : null}
        {message ? <Typo.Body>{message}</Typo.Body> : null}
        {children ? <div className={styles.body}><Typo.Body as="div">{children}</Typo.Body></div> : null}
      </div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
