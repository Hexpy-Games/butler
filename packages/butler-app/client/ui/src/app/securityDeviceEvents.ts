/** Fan out device changes from the app's existing live stream; no extra SSE. */
const listeners = new Set<() => void>();
export function pairedDevicesChanged() {
  for (const listener of listeners) listener();
}
export function subscribePairedDevices(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
