/** A run of text that does or does not match the query. */
export interface TextMatchPart {
  text: string;
  match: boolean;
}

/**
 * Splits text into runs that match any whitespace-separated query term (case-insensitive), in order,
 * with overlapping and touching matches merged. Text whose lowercase form changes length (rare
 * casings) is returned whole and unmatched, so offsets never drift.
 */
export function splitTextMatches(text: string, query: string): TextMatchPart[] {
  const lower = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!text) return [];
  if (!terms.length || lower.length !== text.length) return [{ text, match: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + 1)) marks.fill(true, at, at + term.length);
  }
  const parts: TextMatchPart[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const last = parts.at(-1);
    if (last && last.match === marks[index]) last.text += text[index];
    else parts.push({ text: text[index]!, match: marks[index]! });
  }
  return parts;
}
