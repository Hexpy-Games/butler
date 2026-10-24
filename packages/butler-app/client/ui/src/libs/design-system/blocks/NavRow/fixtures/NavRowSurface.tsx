import type { ReactNode } from "react";
import styles from "./NavRowSurface.module.css";

export type NavRowSurfaceKind = "white" | "tinted";

/** States-matrix rows: each surface, unselected and selected (hover on a selected row is selected + hover). */
export const NAV_ROW_SURFACE_VARIANTS: Record<string, { surface: NavRowSurfaceKind; selected: boolean }> = {
  "White base": { surface: "white", selected: false },
  "White base · selected": { surface: "white", selected: true },
  "Tinted shell": { surface: "tinted", selected: false },
  "Tinted shell · selected": { surface: "tinted", selected: true },
};

/** DS Viewer: rows on a white base (the --selection shades) or on a tinted shell (the white row family). */
export function NavRowSurface({ surface, children }: { surface: NavRowSurfaceKind; children: ReactNode }) {
  return <div className={[styles.surface, surface === "tinted" ? styles.tinted : styles.base].join(" ")} data-nav-row-surface={surface}>{children}</div>;
}
