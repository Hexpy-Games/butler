import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import styles from "./NavRow.module.css";

export interface NavRowProps {
  label: ReactNode;
  /** Destination; omit (or pass null) for a disabled row that never links. */
  href?: string | null;
  icon?: ReactNode;
  /** Trailing meta text, e.g. a status. */
  badge?: ReactNode;
  active?: boolean;
  /** Accessible description for a disabled row. */
  disabledReason?: string;
}

/** A navigation row: a link, the current page, or a disabled (unavailable) destination. */
export function NavRow({ label, href, icon, badge, active = false, disabledReason }: NavRowProps) {
  const disabled = !href;
  const content = (
    <>
      <span className={styles.labelRegion}>
        {icon ? <span aria-hidden="true" className={styles.icon}>{icon}</span> : null}
        <span className={styles.label}>{label}</span>
      </span>
      {badge ? <span className={styles.badge}>{badge}</span> : null}
    </>
  );
  const className = cn(styles.row, active && styles.active, disabled && styles.disabled);
  if (disabled) {
    return (
      <span aria-disabled="true" className={className} data-slot="nav-row" title={disabledReason}>
        {content}
      </span>
    );
  }
  return (
    <a aria-current={active ? "page" : undefined} className={className} data-slot="nav-row" href={href}>
      {content}
    </a>
  );
}
