/**
 * Approval text is the exact action, so characters that hide or reflow it show as escapes:
 * a newline reads `⏎`, and control, default-ignorable (bidi, zero-width, fillers, variation
 * selectors) and non-ASCII whitespace characters read `‹U+XXXX›`.
 */
const HIDDEN = /[\p{Cc}\p{Default_Ignorable_Code_Point}\p{White_Space}]/gu;

export function visibleText(text: string): string {
  return text.replace(HIDDEN, (char) => {
    if (char === " ") return char;
    if (char === "\n") return "⏎";
    return `‹U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}›`;
  });
}
