// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { avatarInitials } from "./avatarInitials";

test("a Hangul name shows its first syllable", () => {
  expect(avatarInitials("하린")).toBe("하");
  expect(avatarInitials("  도현 ")).toBe("도");
});

test("a Latin name shows its first letter, uppercased", () => {
  expect(avatarInitials("minji")).toBe("M");
  expect(avatarInitials("dohyun kim")).toBe("D");
  expect(avatarInitials("élodie")).toBe("É");
});

test("the initial is one whole grapheme, never half of one", () => {
  // Decomposed Hangul (NFD: three jamo) and a combining accent stay together.
  const decomposed = "각".normalize("NFD");
  expect(decomposed).toHaveLength(3);
  expect(avatarInitials(`${decomposed} name`)).toBe(decomposed);
  expect(avatarInitials("e\u0301mile")).toBe("E\u0301");
  // A name with no letter or digit keeps its first grapheme whole.
  expect(avatarInitials("👩‍💻")).toBe("👩‍💻");
});

test("leading symbols are skipped when a letter or digit follows", () => {
  expect(avatarInitials("@minji")).toBe("M");
  expect(avatarInitials("(하린)")).toBe("하");
  expect(avatarInitials("2nd shift")).toBe("2");
});

test("uppercasing never changes the initial's length", () => {
  // "ß" uppercases to "SS"; the avatar keeps one letter.
  expect(avatarInitials("ßtraße")).toBe("ß");
});

test("an empty name has no initial", () => {
  expect(avatarInitials("")).toBe("");
  expect(avatarInitials("   ")).toBe("");
});
