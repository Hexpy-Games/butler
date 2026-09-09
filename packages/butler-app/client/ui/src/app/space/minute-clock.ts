import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let minute = Math.floor(Date.now() / 60_000);
let timer: ReturnType<typeof setInterval> | undefined;
function tick() {
  if (document.hidden) return;
  const next = Math.floor(Date.now() / 60_000);
  if (next === minute) return;
  minute = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    tick();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    }
  };
}
const idle = () => () => {};
export function useMinuteClock(enabled: boolean) {
  return useSyncExternalStore(enabled ? subscribe : idle, () => minute, () => minute);
}
