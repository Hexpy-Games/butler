import type { HTMLAttributes } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./ActivityStrip.module.css";

export interface ActivityStripDay {
  key: string;
  /** Tooltip / title of the day (a localized date). */
  label: string;
  active: boolean;
}

export interface ActivityStripProps extends Omit<DsBaseProps<HTMLAttributes<HTMLSpanElement>>, "children"> {
  days: ActivityStripDay[];
  /** Spoken summary, e.g. the active dates. */
  ariaLabel: string;
}

/** One thin cell per day, filled on active days: a compact "when did it change" strip. */
export function ActivityStrip({ days, ariaLabel, className, ...props }: ActivityStripProps) {
  return (
    <span className={cn(styles.strip, className)} data-slot="activity-strip" aria-label={ariaLabel} role="img" {...props}>
      {days.map((day) => (
        <span key={day.key} className={styles.day} data-active={day.active ? "true" : undefined} title={day.label} />
      ))}
    </span>
  );
}
