import type { UnsafeStyle } from "../../lib/dsProps";

/** Converts persisted panel widths into the shell's geometry contract (pass it as AdaptiveShell `UNSAFE_style`). */
export function adaptivePanelStyle({ leftWidth, rightWidth }: {
  leftWidth: number;
  rightWidth: number;
}): UnsafeStyle {
  return {
    "--sidebar-width": `${leftWidth}px`,
    "--right-panel-width": `${rightWidth}px`,
  };
}
