/** Readiness comes from fresh bootstrap data, then two render frames, never a timer. */
const loaded = new Set<string>();
let signaled = false;
export function startupResourceReady(resource: string) {
  loaded.add(resource);
  if (["navigation", "settings", "catalog", "messages"].every((key) => loaded.has(key))) startupPaintReady();
}
export function startupPaintReady() {
  if (signaled) return;
  signaled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    (window.butlerApp as (typeof window.butlerApp & { signalStartupReady?: () => void }))?.signalStartupReady?.();
  }));
}
