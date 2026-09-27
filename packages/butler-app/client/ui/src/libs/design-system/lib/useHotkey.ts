import { useEffect, useRef } from "react";

/**
 * A global keyboard shortcut (DS spec S6). A combo is `+`-joined modifiers
 * and a key, e.g. "mod+k" or "escape"; `mod` is Cmd on macOS and Ctrl
 * elsewhere. Never fires while an IME is composing (Korean, Japanese,
 * Chinese input), on key repeat, or once another handler took the key.
 */
export type HotkeyPlatform = "mac" | "other";

const MODIFIERS = ["mod", "shift", "alt"] as const;

function currentPlatform(): HotkeyPlatform {
  if (typeof navigator === "undefined") return "other";
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/iu.test(platform) ? "mac" : "other";
}

export function matchesHotkey(event: KeyboardEvent, combo: string, platform: HotkeyPlatform = currentPlatform()): boolean {
  // keyCode 229 is the IME "process" key: the keystroke belongs to a composition.
  if (event.isComposing || event.keyCode === 229 || event.repeat) return false;
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop();
  const wants = new Set(parts);
  const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
  const other = platform === "mac" ? event.ctrlKey : event.metaKey;
  if (mod !== wants.has("mod") || other) return false;
  if (event.shiftKey !== wants.has("shift") || event.altKey !== wants.has("alt")) return false;
  if (parts.some((part) => !(MODIFIERS as readonly string[]).includes(part))) return false;
  return event.key.toLowerCase() === key;
}

export interface HotkeyOptions {
  enabled?: boolean;
  /**
   * `high` handles the key before `default` owners (it listens on the
   * document, which a bubbling key event reaches before the window), e.g. a
   * palette demo inside the DS Viewer, whose own Cmd+K focuses search.
   */
  priority?: "default" | "high";
}

/** Calls `handler` for `combo` on window keydown and prevents the browser default then. */
export function useHotkey(combo: string, handler: (event: KeyboardEvent) => void, { enabled = true, priority = "default" }: HotkeyOptions = {}) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // An inner owner (registered first) that handled the key wins.
      if (event.defaultPrevented || !matchesHotkey(event, combo)) return;
      event.preventDefault();
      latest.current(event);
    };
    const target: Window | Document = priority === "high" ? document : window;
    target.addEventListener("keydown", onKeyDown as EventListener);
    return () => target.removeEventListener("keydown", onKeyDown as EventListener);
  }, [combo, enabled, priority]);
}
