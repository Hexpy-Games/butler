// test-category: security
import { expect, test } from "bun:test";
import { visibleText } from "./visibleText";

const escaped = (code: number) => `‹U+${code.toString(16).toUpperCase().padStart(4, "0")}›`;

test("characters that hide or reflow an action show as escapes, and plain text is untouched", () => {
  expect(visibleText("ls -la 'a b'  c")).toBe("ls -la 'a b'  c");
  expect(visibleText("한국어 명령 ✓ 😀")).toBe("한국어 명령 ✓ 😀");
  expect(visibleText("a\nb")).toBe("a⏎b");
  for (const code of [
    0x09, 0x0D, 0x1B, 0x7F, // tab, CR, ESC, DEL
    0xA0, 0x2003, 0x3000, 0x2028, // non-ASCII whitespace, line separator
    0x200B, 0x200D, 0x2060, 0xFEFF, 0x00AD, // zero-width, joiner, word joiner, BOM, soft hyphen
    0x202A, 0x202E, 0x2066, 0x2069, // bidi controls
    0x115F, 0x3164, 0xFFA0, 0x2800, // fillers and the blank Braille pattern
    0xFE0F, 0xE0100, 0xE0041, // variation selectors, tag characters
    0xE000, 0xF0000, 0xFFFC, // private use, object replacement
    0x0334, 0x0338, 0x20D2, 0x20E3, // overlay marks
  ]) expect(visibleText(`a${String.fromCodePoint(code)}b`), code.toString(16)).toBe(`a${escaped(code)}b`);
});

test("the escape's own glyphs are escaped, so two different texts never read the same", () => {
  expect(visibleText("a⏎b")).toBe(`a${escaped(0x23CE)}b`);
  expect(visibleText("‹U+202E›")).toBe(`${escaped(0x2039)}U+202E${escaped(0x203A)}`);
  expect(visibleText("a\nb")).not.toBe(visibleText("a⏎b"));
  expect(visibleText("\u202E")).not.toBe(visibleText("‹U+202E›"));
});
