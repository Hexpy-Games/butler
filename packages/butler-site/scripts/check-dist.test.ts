// test-category: pure-logic
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkDist } from "./check-dist";
import { SITE_ROOT } from "./check-token-sync";

describe("check-dist.test.ts", () => {
let dir: string;

function put(path: string, text = "<!doctype html>"): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function redirect(to: string): string {
  return `<meta content="0;url=${to}" http-equiv="refresh"><a href="${to}">`;
}

function page(locale: string): string {
  return `<!doctype html><html lang="${locale}">`;
}

function completeSite(): void {
  put("CNAME", "butler.hexpy.games\n");
  put("index.html", redirect("/help/"));
  put("404.html", '<script src="/ds/ds-404-redirect.js"></script>');
  put("help/index.html", page("ko"));
  put("help/models/cloud/index.html", page("ko"));
  put("en/help/index.html", page("en"));
  put("en/help/models/cloud/index.html", page("en"));
  put("docs/index.html", redirect("/help/"));
  put("docs/models/cloud/index.html", redirect("/help/models/cloud/"));
  put("pagefind/pagefind.js", "");
  put("pagefind/pagefind-entry.json", JSON.stringify({ languages: { ko: {}, en: {} } }));
  put("ds/index.html");
  put("ds/ds-404-redirect.js", "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butler-site-dist-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkDist", () => {
  test("accepts the integrated site", () => {
    completeSite();
    expect(checkDist(dir, { base: "/", domain: "butler.hexpy.games" })).toEqual([]);
  });

  test("needs the CNAME for the configured domain", () => {
    completeSite();
    put("CNAME", "butler-design.hexpy.games\n");
    expect(checkDist(dir, { base: "/", domain: "butler.hexpy.games" })).toEqual([
      "CNAME: expected butler.hexpy.games, got butler-design.hexpy.games",
    ]);
  });

  test("the root and every old /docs/ page forward to /help/", () => {
    completeSite();
    put("index.html", "<h1>intro</h1>");
    rmSync(join(dir, "docs/models/cloud"), { recursive: true });
    put("help/projects/index.html", page("ko"));
    put("docs/projects/index.html", redirect("/help/"));
    expect(checkDist(dir, { base: "/", domain: "butler.hexpy.games" })).toEqual([
      "index.html: does not redirect to /help/",
      "docs/models/cloud/index.html: missing (redirect to /help/models/cloud/)",
      "docs/projects/index.html: does not redirect to /help/projects/",
    ]);
  });

  test("the 404 page loads the DS redirect helper for /ds/<path> links", () => {
    completeSite();
    put("404.html", "<h1>404</h1>");
    rmSync(join(dir, "ds/ds-404-redirect.js"));
    expect(checkDist(dir, { base: "/", domain: "butler.hexpy.games" })).toEqual([
      "404.html: does not load /ds/ds-404-redirect.js",
      "ds/ds-404-redirect.js: missing",
    ]);
  });

  test("needs the 404 page, search index and DS Viewer, and only one CNAME / 404", () => {
    completeSite();
    rmSync(join(dir, "404.html"));
    rmSync(join(dir, "pagefind"), { recursive: true });
    rmSync(join(dir, "ds/index.html"));
    put("ds/CNAME", "butler-design.hexpy.games\n");
    put("ds/404.html");
    expect(checkDist(dir, { base: "/", domain: "butler.hexpy.games" })).toEqual([
      "pagefind: no ko search index",
      "pagefind: no en search index",
      "404.html: does not load /ds/ds-404-redirect.js",
      "pagefind/pagefind.js: missing",
      "ds/index.html: missing (run build:ds)",
      "ds/CNAME: only the site root may have one",
      "ds/404.html: only the site root may have one",
    ]);
  });

  test("each locale has its landing page, its <html lang> and its own search index", () => {
    completeSite();
    rmSync(join(dir, "en/help/index.html"));
    put("en/help/models/cloud/index.html", page("ko"));
    put("pagefind/pagefind-entry.json", JSON.stringify({ languages: { ko: {} } }));
    expect(checkDist(dir, { base: "/", domain: "butler.hexpy.games" })).toEqual([
      "en/help/index.html: missing (the en manual)",
      'en/help/models/cloud/index.html: is not <html lang="en">',
    ]);
    put("en/help/index.html", page("en"));
    put("en/help/models/cloud/index.html", page("en"));
    expect(checkDist(dir, { base: "/", domain: "butler.hexpy.games" })).toEqual(["pagefind: no en search index"]);
  });

  test("a locale with only its landing page needs no search index yet", () => {
    completeSite();
    rmSync(join(dir, "en/help/models"), { recursive: true });
    put("pagefind/pagefind-entry.json", JSON.stringify({ languages: { ko: {} } }));
    expect(checkDist(dir, { base: "/", domain: "butler.hexpy.games" })).toEqual([]);
  });
});
});

describe("site-fonts.test.ts", () => {
// The manual uses the app's bundled faces (DS spec Typeface Contract), not a copy.
test("base.css loads the app's bundled fonts.css, which exists", () => {
  const base = readFileSync(join(SITE_ROOT, "src", "ds", "base.css"), "utf8");
  const ref = /@import url\("([^"]*fonts\/fonts\.css)"\);/u.exec(base)?.[1];
  expect(ref).toBe("../../../butler-app/client/ui/src/libs/design-system/fonts/fonts.css");
  expect(existsSync(join(SITE_ROOT, "src", "ds", ref!))).toBe(true);
});

test("the site root ships the fonts' OFL notices", () => {
  expect(readFileSync(join(SITE_ROOT, "scripts", "build-ds.ts"), "utf8")).toContain("THIRD_PARTY_NOTICES.txt");
});
});
