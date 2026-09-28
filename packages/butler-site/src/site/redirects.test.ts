import { describe, expect, test } from "bun:test";
import { isManualPage, redirectScript } from "./redirects";

describe("redirectScript", () => {
  function run(script: string, hash: string): string | undefined {
    let replaced: string | undefined;
    new Function("location", script)({ hash, replace: (url: string) => (replaced = url) });
    return replaced;
  }

  test("forwards to the target and keeps the #anchor of the old link", () => {
    expect(run(redirectScript("/help/models/cloud/"), "#%EC%97%B0%EA%B2%B0")).toBe("/help/models/cloud/#%EC%97%B0%EA%B2%B0");
    expect(run(redirectScript("/help/"), "")).toBe("/help/");
  });

  test("cannot close the inline script element", () => {
    expect(redirectScript("/help/</script><b>")).not.toContain("</script>");
  });
});

describe("isManualPage", () => {
  test("keeps manual pages in every locale", () => {
    expect(isManualPage("https://butler.hexpy.games/help/", "/")).toBe(true);
    expect(isManualPage("https://butler.hexpy.games/help/models/cloud/", "/")).toBe(true);
    expect(isManualPage("https://butler.hexpy.games/en/help/models/cloud/", "/")).toBe(true);
    expect(isManualPage("http://localhost:4321/preview/help/", "/preview/")).toBe(true);
  });

  test("drops the root and legacy /docs/ redirects", () => {
    expect(isManualPage("https://butler.hexpy.games/", "/")).toBe(false);
    expect(isManualPage("https://butler.hexpy.games/docs/", "/")).toBe(false);
    expect(isManualPage("https://butler.hexpy.games/docs/models/cloud/", "/")).toBe(false);
    expect(isManualPage("https://butler.hexpy.games/helper/", "/")).toBe(false);
  });
});
