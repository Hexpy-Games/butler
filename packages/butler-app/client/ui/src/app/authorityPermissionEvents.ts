/** Reuse the app's live stream; settings refreshes only when authority changes. */
const listeners = new Set<() => void>();
export function authorityPermissionsChanged() {
  for (const listener of listeners) listener();
}
export function subscribeAuthorityPermissions(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
