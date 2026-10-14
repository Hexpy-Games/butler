import { createContext, useContext } from "react";

/**
 * How the app shell frames its content.
 * - `flat`: sidebar | (title bar over the workspace), square, one window frame.
 * - `cards`: the sidebar, window chrome and title row are one shell surface; content sits in
 *   rounded cards inset from the window edges (docked layout only; drawers stay full-bleed).
 */
export type ShellFrame = "flat" | "cards";

export const ShellFrameContext = createContext<ShellFrame>("flat");

/** The frame of the enclosing AdaptiveShell (`flat` outside one). Blocks use it to draw their card mode. */
export function useShellFrame(): ShellFrame {
  return useContext(ShellFrameContext);
}

/**
 * The workspace clip while the inspector slides in. Flat: the right edge, so nothing shows under the
 * panel. Cards: the same cut below the title row only, so the title icons (which span to the window
 * edge) stay visible and in place. `cut` is the clipped width in px; `title` the title row height.
 */
export function inspectorSlideClip(frame: ShellFrame, cut: number, title: number): string {
  const x = Math.round(cut);
  if (frame === "flat") return `inset(0px ${x}px 0px 0px)`;
  const t = Math.round(title);
  return `polygon(0px 0px, 100% 0px, 100% ${t}px, calc(100% - ${x}px) ${t}px, calc(100% - ${x}px) 100%, 0px 100%)`;
}
