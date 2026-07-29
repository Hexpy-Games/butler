const LEGACY_DISPLAY_TITLE_LENGTH = 24;

export function compactLegacyDisplayTitle(value: string): string {
  const title = value.trim();
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" })
    .segment(title)]
    .map(({ segment }) => segment);
  if (segments.length <= LEGACY_DISPLAY_TITLE_LENGTH) return title;
  return `${segments.slice(0, LEGACY_DISPLAY_TITLE_LENGTH).join("")}…`;
}
