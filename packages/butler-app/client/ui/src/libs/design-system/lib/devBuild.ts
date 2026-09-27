/**
 * True outside production builds (Vite dev, tests). Structural contracts
 * (a settings field inside a section, a settings page of sections) throw only
 * here, so a production window never crashes on them.
 */
export function isDevBuild(): boolean {
  const env = (import.meta as { env?: { PROD?: boolean } }).env;
  return env?.PROD !== true;
}
