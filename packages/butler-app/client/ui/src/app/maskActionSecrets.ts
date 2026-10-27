/** Redact credential values while preserving the exact action and argument names. */
export function maskActionSecrets(text: string): string {
  const name = String.raw`(?:[\w-]*[_-])?(?:token|secret|password|passwd|api[_-]key|apikey|access[_-]key|private[_-]key|client[_-]secret)(?:[_-][\w-]*)?`;
  const value = String.raw`("[^"\n]*"|'[^'\n]*'|[^\s&;"'\x60]+)`;
  return text
    .replace(/(\bauthorization\s*:\s*(?:bearer\s+|basic\s+))[^\s"'`]+/giu, "$1••••")
    .replace(new RegExp(String.raw`(^|[^\w/-])(${name})(=)${value}`, "giu"), "$1$2$3••••")
    .replace(new RegExp(String.raw`(^|\s)(--${name})(=|\s+)${value}`, "giu"), "$1$2$3••••")
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/[^\s/@:]+:)[^\s/@]+(@)/giu, "$1••••$2")
    .replace(/(?<![\w/.-])(?:(?:sk-|ghp_|gho_|github_pat_|xox[bp]-)[a-zA-Z0-9_-]+|AKIA[A-Z0-9]{16})(?![\w/.-])/gu, "••••");
}
