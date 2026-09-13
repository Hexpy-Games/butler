import { unicodeCaseFold } from "../projection/unicode.ts";
import { sourceQueryTerms } from "../projection/source-index.ts";

/** Locate using normalized keys, but always return a contiguous original quote. */
export function rawSourceExcerpt(text: string, phrases: string[], limit = 480): string {
  const segments = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)];
  if (segments.length <= limit) return text;
  const offsets: number[] = [];
  let folded = "";
  for (const item of segments) {
    offsets.push(folded.length);
    folded += unicodeCaseFold(item.segment);
  }
  const keys = [...phrases.map((phrase) => unicodeCaseFold(phrase.trim())), ...sourceQueryTerms(phrases)]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  let match = -1;
  for (const key of keys) {
    match = folded.indexOf(key);
    if (match >= 0) break;
  }
  const matchIndex = match < 0 ? 0 : Math.max(0, offsets.findLastIndex((offset) => offset <= match));
  const start = Math.min(Math.max(0, matchIndex - Math.floor(limit / 4)), segments.length - limit);
  const end = start + limit;
  return text.slice(segments[start]!.index, segments[end]?.index ?? text.length);
}
