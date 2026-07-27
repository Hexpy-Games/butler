import { basename } from "node:path";

const NON_AUTHORITATIVE_STORAGE_NAMES = new Set([
  ".DS_Store",
  "github-issues.json",
]);

export function isNonAuthoritativeProjectLedgerStorage(filePath) {
  return NON_AUTHORITATIVE_STORAGE_NAMES.has(basename(filePath));
}
