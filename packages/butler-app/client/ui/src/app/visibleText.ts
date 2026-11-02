/**
 * Approval text is the exact action, so characters that hide or reflow it show as escapes:
 * a newline reads `⏎`, and every other character below reads `‹U+XXXX›`:
 * - control and format characters (bidi, zero-width, tags, ESC), default-ignorable ones
 *   (fillers, variation selectors), private-use and the object replacement character;
 * - non-ASCII whitespace, the blank Braille pattern U+2800, and combining overlay marks
 *   that strike through the text before them;
 * - the escape's own glyphs `⏎ ‹ ›`, so a literal one can never pass for an escape.
 */
const HIDDEN = new RegExp(String.raw`[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\p{White_Space}⠀￼⏎‹›]|[̴-̸⃒⃓⃘-⃚⃝-⃤]`, "gu");

function escapeHidden(text: string, kept: (char: string) => string | undefined): string {
  return text.replace(HIDDEN, (char) => kept(char) ?? `‹U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}›`);
}

export function visibleText(text: string): string {
  return escapeHidden(text, (char) => char === " " ? char : char === "\n" ? "⏎" : undefined);
}

/**
 * A command body in a code frame, where layout whitespace shows as itself: the space, the tab and
 * the newline stay real, so indentation and line breaks keep their shape and a long run of spaces
 * pushes the rest sideways under the frame's scroll fade. Everything else escapes as in `visibleText`.
 */
export function visibleCode(text: string): string {
  return escapeHidden(text, (char) => char === " " || char === "\t" || char === "\n" ? char : undefined);
}
