/**
 * Store rules — four numeric parts each <= 65535; the fourth is 0 (reserved for the Store),
 * the first cannot be 0 (Microsoft "App package requirements for MSIX app"). Every submission
 * must sort higher: every preview of M.m.p sorts below M.m.p and above every earlier release.
 * Read back by `butler_platform::store_update::app_version` (Rust).
 * Limits: patch <= 64, previews per patch <= 998.
 */
export function storePackageVersion(appVersion: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/u.exec(appVersion);
  if (!match) throw new Error("Invalid App version");
  const slot = match[4] === undefined ? 999 : Number(match[4]);
  if (match[4] !== undefined && slot > 998) throw new Error("Preview number must be at most 998");
  const parts = [Number(match[1]) + 1, Number(match[2]), Number(match[3]) * 1000 + slot];
  if (parts.some(part => part > 65535)) throw new Error("Store version parts must be at most 65535");
  return [...parts, 0].join(".");
}
