import type { ReactNode } from "react";
import styles from "./InspectorShell.module.css";

/**
 * Insets full-width inspector content (sections, activity feeds) by the
 * inspector's inline padding so it lines up with InspectorPanel cards.
 * `fill` lets the content take the remaining height of the inspector column.
 */
export function InspectorInset({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  return (
    <div className={styles.inset} data-fill={fill ? "true" : undefined}>
      {children}
    </div>
  );
}
