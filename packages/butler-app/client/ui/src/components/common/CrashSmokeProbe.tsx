import { useSyncExternalStore } from "react";

declare global {
  interface Window { __butlerCrashSmoke?: { inject(scope: string): void } }
}

const listeners = new Set<() => void>();
let failingScope: string | null = null;

// A separate smoke build opts in; ordinary production builds erase the hook.
if (import.meta.env.MODE === "crash-smoke") {
  window.__butlerCrashSmoke = { inject(scope) {
    failingScope = scope;
    for (const listener of listeners) listener();
  } };
}

export function clearCrashSmoke(scope: string): void {
  if (import.meta.env.MODE !== "crash-smoke" || failingScope !== scope) return;
  failingScope = null;
  for (const listener of listeners) listener();
}

export function CrashSmokeProbe({ scope }: { scope: string }) {
  const current = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => failingScope);
  if (current === scope) throw new Error("TypeError: Cannot read properties of undefined (reading 'private conversation sk-secret')");
  return null;
}
