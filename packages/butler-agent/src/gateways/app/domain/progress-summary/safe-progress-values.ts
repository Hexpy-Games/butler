export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeBooleanLike(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function safeShortToken(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text && /^[\w:./-]+$/u.test(text) ? text.slice(0, 96) : fallback;
}

export function safeOptionalShortToken(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || !/^[\w:./-]+$/u.test(text)) return undefined;
  return text.slice(0, 96);
}

export function safeShortText(value: unknown, fallback: string): string {
  return safeOptionalShortText(value) ?? fallback;
}

export function safeOptionalShortText(value: unknown): string | undefined {
  const text =
    typeof value === "string" ? stripControlCharacters(value).trim() : "";
  if (!text) return undefined;
  return text
    .replace(
      /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu,
      "[redacted]",
    )
    .replace(/\s+/gu, " ")
    .slice(0, 180);
}

export function safeOptionalNonNegativeInteger(
  value: unknown,
): number | undefined {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined;
  return Math.round(numberValue);
}

export function safeIsoDate(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  return Number.isFinite(Date.parse(text)) ? text : fallback;
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}
