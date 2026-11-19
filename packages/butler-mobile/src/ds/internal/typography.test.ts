import { expect, test } from "bun:test";
import { keepHangulWords } from "./typography";

// test-category: pure-logic
test("keepHangulWords keeps Hangul words together", () => {
  expect(keepHangulWords("주소 확인")).toBe("주\u2060소 확\u2060인");
  expect(keepHangulWords("Butler에")).toBe("Butler\u2060에");
  expect(keepHangulWords("a b")).toBe("a b");
});
