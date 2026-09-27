import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ds-site/ds-404-redirect.js runs in a host's 404 page; evaluate it against a fake window.
const source = readFileSync(
  join(import.meta.dir, "..", "..", "packages", "butler-app", "client", "ui", "ds-site", "ds-404-redirect.js"),
  "utf8",
);

interface Helper {
  base: string;
  redirectTarget: (base: string, pathname: string, search: string, hash: string) => string | null;
}

function load(base: string, url: string): { helper: Helper; replaced: string[] } {
  const replaced: string[] = [];
  const { pathname, search, hash } = new URL(url, "https://example.test");
  const window = { location: { pathname, search, hash, replace: (next: string) => replaced.push(next) } } as {
    location: unknown; butlerDsSite?: Helper;
  };
  new Function("window", source.replace('"__DS_SITE_BASE__"', JSON.stringify(base)))(window);
  return { helper: window.butlerDsSite as Helper, replaced };
}

describe("ds-site 404 redirect helper", () => {
  test("maps a root path onto the query route, keeping query and hash", () => {
    expect(load("/", "/components/Button").replaced).toEqual(["/?page=components%2FButton"]);
    expect(load("/", "/components/Button/?theme=dark#variants").replaced)
      .toEqual(["/?page=components%2FButton&theme=dark#variants"]);
  });

  test("maps a sub-path link and only acts under its base", () => {
    expect(load("/ds/", "/ds/components/Button").replaced).toEqual(["/ds/?page=components%2FButton"]);
    expect(load("/ds/", "/ds").replaced).toEqual(["/ds/"]);
    expect(load("/ds/", "/help/missing").replaced).toEqual([]);
    expect(load("/ds/", "/dsx/components/Button").replaced).toEqual([]);
    expect(load("/ds/", "/ds/").replaced).toEqual([]);
  });

  test("never leaves the base, even for protocol-relative looking paths", () => {
    const { helper } = load("/", "/");
    expect(helper.redirectTarget("/", "//evil.example/x", "", "")).toBe("/?page=evil.example%2Fx");
    expect(helper.redirectTarget("/ds/", "/ds//evil.example", "", "")).toBe("/ds/?page=evil.example");
  });
});
