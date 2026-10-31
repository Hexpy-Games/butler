/**
 * Approval text is the exact action, so characters that hide or reflow it show as escapes:
 * a newline reads `⏎`, and every other character below reads `‹U+XXXX›`:
 * - control and format characters (bidi, zero-width, tags, ESC), default-ignorable ones
 *   (fillers, variation selectors), private-use and the object replacement character;
 * - non-ASCII whitespace, the blank Braille pattern U+2800, and combining overlay marks
 *   that strike through the text before them;
 * - the escape's own glyphs `⏎ ‹ ›`, so a literal one can never pass for an escape.
 */
const HIDDEN = new RegExp(String.raw`[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\p{White_Space}\u2800\uFFFC⏎‹›]|[\u0334-\u0338\u20D2\u20D3\u20D8-\u20DA\u20DD-\u20E4]`, "gu");

export function visibleText(text: string): string {
  return text.replace(HIDDEN, (char) => {
    if (char === " ") return char;
    if (char === "\n") return "⏎";
    return `‹U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}›`;
  });
}
