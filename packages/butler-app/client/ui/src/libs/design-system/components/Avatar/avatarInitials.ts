const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

const LETTER_OR_DIGIT = /^[\p{L}\p{N}]/u;

function graphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (part) => part.segment);
  return Array.from(text);
}

/**
 * The one-grapheme initial an Avatar shows: the first letter or digit of the
 * name (the first grapheme when it has none), uppercased when that keeps it
 * one letter. "연우" → "연", "minji" → "M", "@minji" → "M".
 */
export function avatarInitials(name: string): string {
  const parts = graphemes(name.trim());
  const first = parts.find((part) => LETTER_OR_DIGIT.test(part)) ?? parts[0] ?? "";
  const upper = first.toLocaleUpperCase();
  return graphemes(upper).length === 1 && upper.length === first.length ? upper : first;
}
