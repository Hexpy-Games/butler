import { describe, expect, test } from "bun:test";
import { dsAssetProblems } from "./build-ds";

describe("dsAssetProblems", () => {
  test("accepts a viewer built for /ds/", () => {
    const html = '<link rel="icon" href="data:,"><script type="module" src="/ds/assets/index-a1.js"></script><link rel="stylesheet" href="/ds/assets/index-b2.css">';
    expect(dsAssetProblems(html, "/ds/")).toEqual([]);
  });

  test("rejects a build that ignored DS_SITE_BASE", () => {
    const html = '<script type="module" src="./assets/index-a1.js"></script><link rel="stylesheet" href="/assets/index-b2.css">';
    expect(dsAssetProblems(html, "/ds/")).toEqual([
      "./assets/index-a1.js is not under /ds/",
      "/assets/index-b2.css is not under /ds/",
    ]);
  });

  test("rejects a page with no bundle at all", () => {
    expect(dsAssetProblems("<html></html>", "/ds/")).toEqual(["no script or stylesheet in index.html"]);
  });
});
