/** Sandbox launch flags are explicit; smoke assertions remain unchanged. */
export function smokeBrowserArgs(): string[] {
  const args: unknown = JSON.parse(process.env.BUTLER_SMOKE_BROWSER_ARGS ?? "[]");
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("BUTLER_SMOKE_BROWSER_ARGS must be a JSON string array");
  }
  return args;
}
