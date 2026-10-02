/** Extra launch arguments for restricted smoke environments; assertions stay unchanged. */
export function smokeBrowserArgs(): string[] {
  return JSON.parse(process.env.BUTLER_SMOKE_BROWSER_ARGS ?? "[]") as string[];
}
