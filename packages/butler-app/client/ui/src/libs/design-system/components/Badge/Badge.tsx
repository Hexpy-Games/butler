import { useEffect, useRef, type MouseEvent } from "react";
import { Tooltip } from "../Tooltip";
import { Typo } from "../Typo";
import { dsClass } from "../../lib/internal";
import { playBadgeSheen } from "./badgeSheen";
import styles from "./Badge.module.css";

export interface BadgeProps {
  /** The plan name in its copy casing ("Plus"); CSS sets it in capitals. */
  children: string;
  /** Shown on hover and keyboard focus; the badge then becomes a focus stop. It never acts. */
  tooltip?: string;
}

/** A badge never acts: inside a <label>, its click must not reach the labelled control. */
function keepClick(event: MouseEvent<HTMLSpanElement>) {
  event.preventDefault();
}

/** A filled pill naming a plan (Plus, Pro, Enterprise), with a periodic sheen. */
export function Badge({ children, tooltip }: BadgeProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => (ref.current ? playBadgeSheen(ref.current) : undefined), []);
  const badge = (
    <span ref={ref} className={styles.badge} data-slot="badge" tabIndex={tooltip ? 0 : undefined} onClick={keepClick}>
      <Typo.Caption className={dsClass(styles.label)} wrap="nowrap">{children}</Typo.Caption>
    </span>
  );
  return tooltip ? <Tooltip label={tooltip}>{badge}</Tooltip> : badge;
}
