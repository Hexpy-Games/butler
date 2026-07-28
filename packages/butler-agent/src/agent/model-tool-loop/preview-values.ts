export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function boundedText(value: unknown, maxChars: number): string | undefined {
  const valueText = text(value);
  if (!valueText) return undefined;
  return valueText.length <= maxChars
    ? valueText
    : `${valueText.slice(0, maxChars)}...`;
}

export function boundedHeadTailText(
  value: unknown,
  maxChars: number,
): string | undefined {
  const valueText = text(value);
  if (!valueText) return undefined;
  if (valueText.length <= maxChars) return valueText;
  const marker = "\n...[middle omitted]...\n";
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.floor(available * 0.4);
  return `${valueText.slice(0, headLength)}${marker}${
    valueText.slice(-(available - headLength))
  }`;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function compactUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
