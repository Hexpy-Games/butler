import { setWallpaperDiagnostics, wallpaperDebugState } from "@/butler-ds";
import { wallpaperStateLine } from "./wallpaperStateLine";

/** At most one line per signal per second (the latest state of a burst still lands), and a session cap. */
const MIN_GAP_MS = 1000;
const SESSION_CAP = 200;

/**
 * Sends the wallpaper run-state transitions to the main-process log (desktop App only). Change-driven: the engines
 * report only transitions, so an idle window sends nothing. The first-run step comes from the setup screen.
 */
export function installWallpaperDiagnostics(): void {
  const record = window.butlerApp?.recordWallpaperState;
  if (typeof record !== "function") return;
  // Read-only live engine state for a debugger (CDP `__butlerWallpaperDebug.state()`); nothing runs until called.
  Object.defineProperty(window, "__butlerWallpaperDebug", { value: Object.freeze({ state: wallpaperDebugState }) });
  const last = new Map<string, number>();
  const pending = new Map<string, string>();
  let sent = 0;
  const send = (signal: string, line: string) => {
    last.set(signal, performance.now());
    if (sent >= SESSION_CAP) return;
    sent += 1;
    // Diagnostics are best-effort: an unavailable log bridge must not break a view.
    try { record(line); } catch { /* Keep rendering when the log sink is unavailable. */ }
  };
  setWallpaperDiagnostics((event) => {
    const step = document.querySelector("[data-first-run-screen]")?.getAttribute("data-first-run-screen");
    const line = wallpaperStateLine(event, step);
    const gap = performance.now() - (last.get(event.signal) ?? Number.NEGATIVE_INFINITY);
    if (gap >= MIN_GAP_MS && !pending.has(event.signal)) return send(event.signal, line);
    const queued = pending.has(event.signal);
    pending.set(event.signal, line);
    if (queued) return;
    window.setTimeout(() => {
      const latest = pending.get(event.signal);
      pending.delete(event.signal);
      if (latest) send(event.signal, latest);
    }, Math.max(0, MIN_GAP_MS - gap));
  });
}
