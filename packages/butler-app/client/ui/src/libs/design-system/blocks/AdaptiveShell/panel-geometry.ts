import type { CSSProperties } from "react";

/** Converts persisted panel widths into the shell's CSS geometry contract. */
export function adaptivePanelStyle({ leftWidth, rightWidth }: {
  leftWidth: number;
  rightWidth: number;
}): CSSProperties {
  return {
    "--sidebar-width": `${leftWidth}px`,
    "--right-panel-width": `${rightWidth}px`,
  } as CSSProperties;
}
