import { Children, type HTMLAttributes, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import styles from "./BlockColumns.module.css";

export interface BlockColumnsProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  /** Two or three content blocks, one per column. Columns never hold another BlockColumns or BlockTabs. */
  children: ReactNode;
}

/**
 * Two or three content blocks side by side. It measures its own width (not the page), so the same
 * blocks stack in a narrow place: a phone, a 서랍 card or a side panel.
 */
export function BlockColumns({ children, className, ...props }: BlockColumnsProps) {
  const columns = Children.toArray(children);
  return (
    <div {...props} className={dsClass(styles.frame, className)} data-slot="block-columns">
      <div className={styles.columns} data-count={Math.min(columns.length, 3)}>
        {columns.map((column, index) => <div className={styles.column} key={index}>{column}</div>)}
      </div>
    </div>
  );
}
