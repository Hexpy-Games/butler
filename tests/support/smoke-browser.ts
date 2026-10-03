/** Optional launch arguments for restricted browser sandboxes. */
export function smokeBrowserArgs(): string[] {
  const value = process.env.BUTLER_SMOKE_BROWSER_ARGS;
  if (!value) return [];
  const args: unknown = JSON.parse(value);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("BUTLER_SMOKE_BROWSER_ARGS must be a JSON string array");
  }
  return args;
}
