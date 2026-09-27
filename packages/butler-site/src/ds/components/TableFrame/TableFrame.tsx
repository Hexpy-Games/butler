import type { ReactNode } from "react";
import styles from "./TableFrame.module.css";

export interface TableFrameProps {
  /** Table sections; MDX passes the markdown table's thead and tbody. */
  children?: ReactNode;
}

/**
 * Document table, forked from the app DS MarkdownTable: hairline grid with a
 * tinted header row inside a horizontal scroller whose clipped edges fade
 * (scroll-fade.css; lib/scrollEdges.ts keeps the edge state current).
 */
export function TableFrame({ children }: TableFrameProps) {
  return (
    <div className={styles.frame} data-scroll-fade="x" data-slot="table-frame" tabIndex={0}>
      <table className={styles.table}>{children}</table>
    </div>
  );
}
