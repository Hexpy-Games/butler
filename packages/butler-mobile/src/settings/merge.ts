export function mergeSettings<T extends object>(current: T, patch: Partial<T>): T {
  const merged = { ...current, ...patch };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const before = current[key];
    const after = patch[key];
    if (before && after && typeof before === "object" && typeof after === "object"
      && !Array.isArray(before) && !Array.isArray(after)
      && Object.getPrototypeOf(before) === Object.prototype && Object.getPrototypeOf(after) === Object.prototype) {
      Object.assign(merged, { [key]: { ...before, ...after } });
    }
  }
  return merged;
}
