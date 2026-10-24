// test-category: pure-logic
import { expect, test } from "bun:test";
import { compactTokens } from "./compactTokens";

test("Korean groups whole units and never uses Latin compact suffixes", () => {
  for (const [value, text] of [[999, "999"], [1234, "1.2천"], [71431000, "7,143만"], [2040000000, "20.4억"], [9999, "1만"], [99999999, "1억"], [1000, "1천"], [962400000, "9.6억"]] as const) {
    expect(compactTokens(value, "ko-KR")).toBe(text);
  }
});

test("other locales use three significant digits without trailing zeros", () => {
  for (const [value, text] of [[999, "999"], [2040000000, "2.04B"], [962400000, "962M"], [12400, "12.4K"], [999999, "1M"], [999950000, "1B"], [1000, "1K"], [96200000, "96.2M"]] as const) {
    expect(compactTokens(value, "en-US")).toBe(text);
  }
  expect(compactTokens(12400, "de-DE")).toBe("12,4K");
  expect(compactTokens(0, "en-US")).toBe("0");
});
