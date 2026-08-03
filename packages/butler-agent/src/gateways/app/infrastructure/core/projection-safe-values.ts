export function safeParseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function safeOptionalShortToken(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || !/^[\w:./-]+$/u.test(text)) return undefined;
  return text.slice(0, 96);
}

export function safeInboundQueueId(value: unknown): string | undefined {
  const text = safeOptionalShortToken(value);
  if (!text || text.includes("..") || text.includes("/") || text.includes("\\")) {
    return undefined;
  }
  return text;
}

export function safeShortTokenList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeOptionalShortToken(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, 8);
}

export function safeShortTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeLimitationText(item, "A runtime limitation remained."))
    .filter((item): item is string => Boolean(item))
    .slice(0, 8);
}

export function safeShortText(value: unknown, fallback: string): string {
  return safeOptionalShortText(value) ?? fallback;
}

export function safeOptionalShortText(value: unknown): string | undefined {
  return safeOptionalPublicText(value)?.slice(0, 180);
}

export function safeOptionalPublicText(value: unknown): string | undefined {
  const text =
    typeof value === "string" ? stripControlCharacters(value).trim() : "";
  if (!text) return undefined;
  return text
    .replace(
      /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu,
      "[redacted]",
    )
    .replace(/\s+/gu, " ")
    .trim();
}

export function safeLimitationText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  const normalized = text
    .replace(/^(?:INCOMPLETE|미완료)\s*[:：]\s*/iu, "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, "")
    .replace(
      /\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/giu,
      "[redacted]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || containsPrivatePath(normalized)) return fallback;
  return normalized.slice(0, 240);
}

export function safeOptionalNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined;
  return Math.floor(numberValue);
}

export function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}

function containsPrivatePath(value: string): boolean {
  return /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/[^/\s]+|~\/|\$HOME\/|[A-Za-z]:\\Users\\[^\\\s]+)/u
    .test(value) || /raw prompt text/iu.test(value);
}
