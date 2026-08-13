/** Canonical model-facing and mutation-boundary SHA-256 representation. */
export const WORKSPACE_SHA256_PATTERN = "^[a-fA-F0-9]{64}$";

const WORKSPACE_SHA256_RE = /^[a-f0-9]{64}$/iu;

/**
 * Normalize a caller-provided complete-file SHA-256 for every native file
 * mutation. `undefined` means the optional guard was omitted; any other value
 * must be a 64-character hexadecimal digest and is returned lowercase.
 */
export function normalizeWorkspaceSha256(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !WORKSPACE_SHA256_RE.test(value)) return undefined;
  return value.toLowerCase();
}

/** Distinguish an omitted optional guard from an invalid supplied value. */
export function isWorkspaceSha256(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_SHA256_RE.test(value);
}
