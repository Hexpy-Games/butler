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
