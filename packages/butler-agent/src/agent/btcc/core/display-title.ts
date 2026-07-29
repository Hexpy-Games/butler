export const DISPLAY_TITLE_MAX_LENGTH = 32;
export const LEGACY_DISPLAY_TITLE_LENGTH = 24;

export function requireDisplayTitle(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const title = value.trim();
  if ([...title].length > DISPLAY_TITLE_MAX_LENGTH) {
    throw new Error(
      `${label} must not exceed ${DISPLAY_TITLE_MAX_LENGTH} Unicode characters`,
    );
  }
  return title;
}

export function legacyDisplayTitle(value: string): string {
  const title = value.trim();
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" })
    .segment(title)]
    .map(({ segment }) => segment);
  if (segments.length <= LEGACY_DISPLAY_TITLE_LENGTH) return title;
  return `${segments.slice(0, LEGACY_DISPLAY_TITLE_LENGTH).join("")}…`;
}
