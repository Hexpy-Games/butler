import { describe, expect, test } from "bun:test";
import { withBaseHref } from "./baseLinks";

describe("withBaseHref", () => {
  test("prefixes root-relative links with the deploy base", () => {
    expect(withBaseHref("/preview/", "/help/models/cloud/#연결하기")).toBe("/preview/help/models/cloud/#연결하기");
    expect(withBaseHref("/", "/help/a/")).toBe("/help/a/");
  });

  test("leaves external, protocol-relative and in-page links alone", () => {
    expect(withBaseHref("/preview/", "https://example.com/x")).toBe("https://example.com/x");
    expect(withBaseHref("/preview/", "//cdn.example.com/a")).toBe("//cdn.example.com/a");
    expect(withBaseHref("/preview/", "#local")).toBe("#local");
    expect(withBaseHref("/preview/", undefined)).toBeUndefined();
  });
});
