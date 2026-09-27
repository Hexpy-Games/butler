import { describe, expect, test } from "bun:test";
import { withBaseHref } from "./baseLinks";

describe("withBaseHref", () => {
  test("prefixes root-relative links with the deploy base", () => {
    expect(withBaseHref("/butler/", "/docs/models/cloud/#연결하기")).toBe("/butler/docs/models/cloud/#연결하기");
    expect(withBaseHref("/", "/docs/a/")).toBe("/docs/a/");
  });

  test("leaves external, protocol-relative and in-page links alone", () => {
    expect(withBaseHref("/butler/", "https://example.com/x")).toBe("https://example.com/x");
    expect(withBaseHref("/butler/", "//cdn.example.com/a")).toBe("//cdn.example.com/a");
    expect(withBaseHref("/butler/", "#local")).toBe("#local");
    expect(withBaseHref("/butler/", undefined)).toBeUndefined();
  });
});
