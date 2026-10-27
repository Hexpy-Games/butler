/** Redact credential arguments while preserving the operation and argument names. */
export function maskActionSecrets(text: string): string {
  return text
    .replace(/(\bauthorization\s*:\s*)(?:bearer\s+|basic\s+)?[^\s"'`]+/giu, "$1••••")
    .replace(/(\bbearer\s+)[^\s"'`]+/giu, "$1••••")
    .replace(/(\b(?:api[-_]?key|(?:(?:access|auth)[-_]?)?token|secret)\s*(?:=|:|\s)\s*)("[^"\n]*"|'[^'\n]*'|[^\s&;"'`]+)/giu, "$1••••");
}
