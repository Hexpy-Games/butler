import type { WallpaperError } from "./types";

const MESSAGES = {
  degraded: "Frames too slow; holding a still frame",
  "context-lost": "WebGL context lost while drawing",
} as const;

/**
 * Reports a runtime failure of the module on screen (`drawn`; nothing when
 * nothing is drawn): the frame-time watchdog gave up animating it, or the
 * context was lost while it drew. The app may retire a user module for it.
 */
export function reportWallpaperRuntimeFailure(onError: (error: WallpaperError) => void, drawn: string | null, reason: keyof typeof MESSAGES) {
  if (drawn) onError({ reason, module: drawn, message: MESSAGES[reason] });
}
