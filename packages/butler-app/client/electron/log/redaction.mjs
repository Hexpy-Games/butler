// Port of butler-log structured_logging/{patterns,redaction}. No raw headers survive.
const SECRET = /api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|authorization|credential|session[_-]?key|cookie|pairing[_-]?code|connection[_-]?code|^token$/iu;
const QUERY = /^(key|token|code|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$/iu;
const MASK = "[REDACTED]";
const PATTERNS = [
  [new RegExp("(\"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization|credential|session[_-]?key)\"\\s*:\\s*)\"(?:\\\\.|[^\"\\\\])*\"", "giu"), "$1\"[REDACTED]\""],
  [new RegExp("(\\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|PASSWORD|SECRET)[A-Z0-9_]*\\s*[:=]\\s*)\\S+", "giu"), "$1[REDACTED]"],
  [new RegExp("(Bearer\\s+)[A-Za-z0-9._~+/=-]+", "giu"), "$1[REDACTED]"],
  [new RegExp("(OPENAI_API_KEY=)[^\\s]+", "giu"), "$1[REDACTED]"],
  [new RegExp("bot\\d+:[A-Za-z0-9_-]+", "gu"), "bot[REDACTED]"],
  [new RegExp("((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|credential|authorization|session[_-]?key)[\"']?\\s*[:=]\\s*[\"']?)[^\\s,\"'}]+", "giu"), "$1[REDACTED]"],
  [new RegExp("\\bsk-[A-Za-z0-9_-]+", "gu"), "[REDACTED]"],
  [new RegExp("([\"'](?:set-cookie|cookie)[\"']\\s*[:=]\\s*\")(?:\\\\.|[^\"\\\\\\r\\n])*", "giu"), "$1[REDACTED]"],
  [new RegExp("([\"'](?:set-cookie|cookie)[\"']\\s*[:=]\\s*')(?:\\\\.|[^'\\\\\\r\\n])*", "giu"), "$1[REDACTED]"],
  [new RegExp("((?:^|[^\"'A-Za-z0-9_-])(?:set-cookie|cookie)\\s*[:=]\\s*)[^\\r\\n]+", "giu"), "$1[REDACTED]"],
  [new RegExp("\\bv2\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+", "gu"), "[REDACTED]"],
  [new RegExp("((?:pairing|connection)[ _-]?code[\"']?\\s*[:=]\\s*[\"']?)(?:\\d{4}[ \\t]+\\d{4}|[A-Z0-9]{4}(?:[ -][A-Z0-9]{4}){3}|[^\\s,\"'}]+)", "giu"), "$1[REDACTED]"],
  [new RegExp("([?&]code=)[^&\\s\"'<>]+", "giu"), "$1[REDACTED]"],
  [new RegExp("(\\bcode[\"']?\\s*[:=]\\s*[\"']?)(?:\\d{8}|\\d{4}[ \\t]+\\d{4}|[A-Z0-9]{4}(?:[ -][A-Z0-9]{4}){3})\\b", "giu"), "$1[REDACTED]"],
  [new RegExp("(/(?:home|Users)/)[^/\\\\\\r\\n\"'<>]+(/)", "gu"), "$1[redacted-user]$2"],
  [new RegExp("(/(?:home|Users)/)[^/\\\\\\r\\n\"'<>]+([\"'])", "gu"), "$1[redacted-user]$2"],
  [new RegExp("(/(?:home|Users)/)[^/\\\\\\s\"'<>]+", "gu"), "$1[redacted-user]"],
  [new RegExp("((?:[A-Z]:)?\\\\+(?:Users|home)\\\\+)[^/\\\\\\r\\n\"'<>]+(\\\\+)", "giu"), "$1[redacted-user]$2"],
  [new RegExp("((?:[A-Z]:)?\\\\+(?:Users|home)\\\\+)[^/\\\\\\r\\n\"'<>]+([\"'])", "giu"), "$1[redacted-user]$2"],
  [new RegExp("((?:[A-Z]:)?\\\\+(?:Users|home)\\\\+)[^/\\\\\\s\"'<>]+", "giu"), "$1[redacted-user]"],
];
export function createRedactor() {
  const secrets = new Set();
  function remember(value) { if (typeof value === "string" && value) { secrets.add(value); if (/^Bearer /iu.test(value)) secrets.add(value.slice(7)); } }
  function observe(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (SECRET.test(key) || key === "code") remember(item);
      else observe(item);
    }
  }
  function text(input) {
    let result = input;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join(MASK);
    for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
    return result;
  }
  function url(input) {
    try {
      const value = new URL(input);
      if (value.username) value.username = MASK;
      if (value.password) value.password = MASK;
      for (const key of [...value.searchParams.keys()]) if (SECRET.test(key) || QUERY.test(key)) value.searchParams.set(key, MASK);
      // Credential-bearing path components have no diagnostic value in App requests.
      value.pathname = value.pathname.split("/").map(part => part.length >= 16 && /[a-z]/iu.test(part) && /\d/u.test(part) ? MASK : part).join("/");
      return text(value.toString());
    } catch { return text(input); }
  }
  function redact(value) {
    if (typeof value === "string") return text(value).replace(/https?:\/\/[^\s"'<>]+/gu, match => url(match));
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [text(key), SECRET.test(key) && !(key === "secrets_redacted" && typeof item === "boolean") ? MASK : redact(item)]));
    return value;
  }
  return { redact, remember, observe };
}
