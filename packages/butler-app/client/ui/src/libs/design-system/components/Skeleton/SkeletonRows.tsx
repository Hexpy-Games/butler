import { Skeleton } from "../../shadcn/ui/skeleton";
import styles from "./Skeleton.module.css";
import { dsClass } from "../../lib/internal";

export interface SkeletonRowsProps {
  /** Number of placeholder rows. */
  rows?: number;
  /** `list`: list-row height; `field`: a label line above a control. */
  shape?: "list" | "field";
  /** Accessible loading label (announced once for the group). */
  label?: string;
}

/** Placeholder rows while a list or form loads, so it never flashes its empty state. */
export function SkeletonRows({ rows = 3, shape = "list", label }: SkeletonRowsProps) {
  return (
    <div className={styles.rows} data-slot="skeleton-rows" data-shape={shape} aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={styles.row}>
          {shape === "field" ? <Skeleton className={dsClass(styles.label)} /> : null}
          <Skeleton className={dsClass(styles.bar)} />
        </div>
      ))}
    </div>
  );
}
