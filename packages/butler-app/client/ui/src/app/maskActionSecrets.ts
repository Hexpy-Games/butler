/** Redact credential values while preserving the exact action and argument names. */
export function maskActionSecrets(text: string): string {
  const name = String.raw`(?:[\w-]*[_-])?(?:token|secret|password|passwd|pwd|api[_-]key|apikey|access[_-]key|private[_-]key|client[_-]secret)(?:[_-][\w-]*)?`;
  const fieldName = String.raw`(?:[\w-]*[_-])?(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization)`;
  const value = String.raw`("[^"\n]*"|'[^'\n]*'|[^\s&;"'\x60]+)`;
  const fieldValue = String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,}\]"'\x60]+)`;
  // Uppercase environment names may join a prefix directly to the secret word.
  const joinedName = String.raw`[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|APIKEY|ACCESSKEY|PRIVATEKEY)`;
  return text
    .replace(new RegExp(String.raw`(^|[^\w/-])(${joinedName})(=)${value}`, "gu"), "$1$2$3••••")
    .replace(new RegExp(String.raw`(["'])(${fieldName})(\1\s*:\s*)${fieldValue}`, "giu"), "$1$2$3••••")
    .replace(new RegExp(String.raw`(^|[^\w/-])(${fieldName})(\s*:\s*(?:bearer\s+|basic\s+)?)${fieldValue}`, "giu"), "$1$2$3••••")
    .replace(new RegExp(String.raw`(^|[^\w/-])(${name})(=)${value}`, "giu"), "$1$2$3••••")
    .replace(new RegExp(String.raw`(^|\s)(--${name})(=|\s+)${value}`, "giu"), "$1$2$3••••")
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/[^\s/@:]+:)[^\s/@]+(@)/giu, "$1••••$2")
    .replace(/(?<![\w/.-])(?:(?:sk-|ghp_|gho_|github_pat_|xox[bp]-)[a-zA-Z0-9_-]+|AKIA[A-Z0-9]{16})(?![\w/.-])/gu, "••••");
}
