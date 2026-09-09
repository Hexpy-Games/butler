import type { ReactNode } from "react";
import styles from "./InlineReference.module.css";

export function InlineReference({ icon, children, unavailable = false, onClick }: {
  icon: ReactNode; children: ReactNode; unavailable?: boolean; onClick?: () => void;
}) {
  const contents = <><span className={styles.icon}>{icon}</span><span>{children}</span></>;
  return onClick ? <button type="button" className={styles.reference} data-unavailable={unavailable} onClick={onClick}>{contents}</button>
    : <span className={styles.reference} data-unavailable={unavailable} aria-disabled={unavailable || undefined}>{contents}</span>;
}
