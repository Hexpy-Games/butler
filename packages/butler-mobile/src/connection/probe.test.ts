import { expect, test } from "bun:test";
import { butlerOrigin } from "./probe";

// test-category: pure-logic
test("a typed address becomes a plain http(s) origin", () => {
  const cases: [string, string | null][] = [
    ["192.0.2.5:18765", "http://192.0.2.5:18765"],
    ["  https://butler.example.com/ ", "https://butler.example.com"],
    ["butler.local", "http://butler.local"],
    ["", null],
    ["ftp://butler.example.com", null],
    ["http://butler.example.com/app", null],
    ["http://h?x=1", null],
  ];
  for (const [input, expected] of cases) expect(butlerOrigin(input)).toBe(expected);
});
