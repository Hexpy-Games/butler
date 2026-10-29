import type { ReactNode } from "react";
import styles from "./NavRow.module.css";
import type { SidebarDensity } from "../SidebarShell/SidebarShell";

export interface NavRowChildrenProps {
  /** Rows nested under the NavRow just before; give them `reserveIcon` so their labels align with the parent's. */
  children: ReactNode;
  /** Density override; omit inside a SidebarShell to follow the shell's density, as NavRow does. */
  density?: SidebarDensity;
  /** Test identifier */
  dataTestClass?: string;
}

/**
 * Rows nested under the preceding NavRow, joined by a guide line centred on the parent's icon column.
 * The line reads the density's row inset and icon size, so it stays on the icon centre at every density.
 */
export function NavRowChildren({ children, density, dataTestClass }: NavRowChildrenProps) {
  return (
    <div className={styles.children} data-slot="nav-row-children"
      data-sidebar-density={density} data-test-class={dataTestClass}>
      {children}
    </div>
  );
}
