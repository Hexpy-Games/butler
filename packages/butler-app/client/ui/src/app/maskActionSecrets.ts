/** True when the shell would evaluate part of this word: substitution, expansion, or a control character right after it. */
function isEvaluated(word: string, tail: string): boolean {
  if (tail) return true;
  for (const [segment] of word.matchAll(/"(?:\\.|[^"\\\n])*"|'[^'\n]*'|[^"']+/gu)) {
    if (segment.startsWith("'") ? /\$\(|`/u.test(segment) : /[$`]/u.test(segment)) return true;
  }
  return false;
}

/**
 * Redact literal credential values while preserving the exact action and argument names.
 * A value the shell would evaluate (substitution, expansion, trailing control characters) stays
 * visible: for a command, the exact action outranks hiding a secret.
 */
export function maskActionSecrets(text: string): string {
  const name = String.raw`(?:[\w-]*[_-])?(?:token|secret|password|passwd|pwd|api[_-]key|apikey|access[_-]key|private[_-]key|client[_-]secret)(?:[_-][\w-]*)?`;
  const fieldName = String.raw`(?:[\w-]*[_-])?(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization)`;
  const value = String.raw`((?:"(?:\\.|[^"\\\n])*"|'[^'\n]*'|[^\s"'\x60;&|<>()])+)([|<>()\x60]?)`;
  const fieldValue = String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,}\]"'\x60]+)`;
  // Uppercase environment names may join a prefix directly to the secret word.
  const joinedName = String.raw`[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|APIKEY|ACCESSKEY|PRIVATEKEY)`;
  const shell = (_: string, pre: string, key: string, sep: string, word: string, tail: string) =>
    isEvaluated(word, tail) ? _ : `${pre}${key}${sep}••••`;
  const field = (all: string, pre: string, key: string, sep: string, word: string) =>
    /\$[({]|`/u.test(word) ? all : `${pre}${key}${sep}••••`;
  return text
    .replace(new RegExp(String.raw`(^|[^\w/-])(${joinedName})(=)${value}`, "gu"), shell)
    .replace(new RegExp(String.raw`(["'])(${fieldName})(\1\s*:\s*)${fieldValue}`, "giu"), field)
    .replace(new RegExp(String.raw`(^|[^\w/-])(${fieldName})(\s*:\s*(?:bearer\s+|basic\s+)?)${fieldValue}`, "giu"), field)
    .replace(new RegExp(String.raw`(^|[^\w/-])(${name})(=)${value}`, "giu"), shell)
    .replace(new RegExp(String.raw`(^|\s)(--${name})(=|\s+)${value}`, "giu"), shell)
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/[^\s/@:]+:)[^\s/@]+(@)/giu, "$1••••$2")
    .replace(/(?<![\w/.-])(?:(?:sk-|ghp_|gho_|github_pat_|xox[bp]-)[a-zA-Z0-9_-]+|AKIA[A-Z0-9]{16})(?![\w/.-])/gu, "••••");
}
