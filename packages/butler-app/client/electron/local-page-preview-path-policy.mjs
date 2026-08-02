import { normalize } from "node:path";

const SENSITIVE_SEGMENTS = new Set([".git", ".ssh", ".gnupg"]);
const SENSITIVE_FILENAMES = new Set([
  "chatgpt-oauth.json",
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
]);

// This App-owned boundary mirrors the Agent file-tool sensitive-name policy
// without importing Agent internals into the independently packaged shell.
export function isSensitiveLocalPagePreviewPath(pathValue) {
  if (typeof pathValue !== "string") return false;
  const parts = normalize(pathValue).split(/[\\/]+/u).filter(Boolean);
  return parts.some((part, index) => {
    const lower = part.toLowerCase();
    if (SENSITIVE_SEGMENTS.has(lower)) return true;
    if (SENSITIVE_FILENAMES.has(lower)) return true;
    if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
    return index === parts.length - 1 && lower.startsWith(".env");
  });
}
