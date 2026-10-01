import { describe, expect, test } from "bun:test";
import {
  buildNav,
  designSystemRoot,
  docHref,
  docsRoot,
  docSlug,
  localeAlternates,
  pageContext,
  switchHref,
  withBase,
  type DocEntryLike,
} from "./nav";

function entry(id: string, section: string, order: number, status: "published" | "planned" = "published"): DocEntryLike {
  return { id, data: { title: id.split("/").at(-1) ?? id, description: "", section, order, status } } as DocEntryLike;
}

const entries: DocEntryLike[] = [
  entry("ko/basics/composer", "basics", 1, "planned"),
  entry("ko/getting-started/first-run", "getting-started", 2, "planned"),
  entry("ko/getting-started/install", "getting-started", 1),
  entry("ko/models/cloud", "models", 1),
  entry("en/getting-started/install", "getting-started", 1),
];

describe("paths", () => {
  test("joins the base path without doubling slashes", () => {
    expect(withBase("/", "help/")).toBe("/help/");
    expect(withBase("/preview", "/help/")).toBe("/preview/help/");
    expect(withBase("/preview/", "help/a/")).toBe("/preview/help/a/");
  });

  test("strips the locale from entry ids", () => {
    expect(docSlug("ko/getting-started/install")).toBe("getting-started/install");
  });

  test("serves the manual under /help/ and keeps the default locale unprefixed", () => {
    expect(docsRoot("/", "ko")).toBe("/help/");
    expect(docsRoot("/", "en")).toBe("/en/help/");
    expect(docHref("/", "ko", "getting-started/install")).toBe("/help/getting-started/install/");
    expect(docHref("/", "en", "models/cloud")).toBe("/en/help/models/cloud/");
    expect(docHref("/preview/", "ko", "models/cloud")).toBe("/preview/help/models/cloud/");
  });

  test("serves the DS Viewer under /ds/", () => {
    expect(designSystemRoot("/")).toBe("/ds/");
    expect(designSystemRoot("/preview/")).toBe("/preview/ds/");
  });
});

describe("language switching", () => {
  test("a page's alternates are its published translations", () => {
    expect(localeAlternates(entries, "/", "getting-started/install")).toEqual({
      ko: "/help/getting-started/install/",
      en: "/en/help/getting-started/install/",
    });
    expect(localeAlternates(entries, "/", "models/cloud")).toEqual({ ko: "/help/models/cloud/", en: null });
    expect(localeAlternates(entries, "/", "getting-started/first-run")).toEqual({ ko: null, en: null });
  });

  test("every locale has the landing page", () => {
    expect(localeAlternates([], "/preview/", null)).toEqual({ ko: "/preview/help/", en: "/preview/en/help/" });
  });

  test("the switcher keeps the page, or falls back to the other locale's landing page", () => {
    const alternates = localeAlternates(entries, "/", "models/cloud");
    expect(switchHref(alternates, "/", "ko")).toBe("/help/models/cloud/");
    expect(switchHref(alternates, "/", "en")).toBe("/en/help/");
    expect(switchHref(localeAlternates(entries, "/", "getting-started/install"), "/", "en")).toBe("/en/help/getting-started/install/");
  });
});

describe("buildNav", () => {
  const nav = buildNav(entries, { locale: "ko", base: "/", currentSlug: "getting-started/install" });

  test("groups the locale's entries by section in IA order and sorts rows", () => {
    expect(nav.map((section) => section.id)).toEqual(["getting-started", "basics", "models"]);
    expect(nav[0].rows.map((row) => row.slug)).toEqual(["getting-started/install", "getting-started/first-run"]);
    expect(nav[0].title).toBe("시작하기");
  });

  test("planned pages have no link and the current page is active", () => {
    const [install, firstRun] = nav[0].rows;
    expect(install).toMatchObject({ href: "/help/getting-started/install/", active: true, planned: false });
    expect(firstRun).toMatchObject({ href: null, active: false, planned: true });
  });

  test("uses the locale's section labels", () => {
    const en = buildNav(entries, { locale: "en", base: "/", currentSlug: "" });
    expect(en.map((section) => section.title)).toEqual(["Getting started"]);
  });
});

describe("pageContext", () => {
  const nav = buildNav(entries, { locale: "ko", base: "/", currentSlug: "getting-started/install" });

  test("prev/next skip planned pages across sections", () => {
    const context = pageContext(nav, "getting-started/install");
    expect(context.prev).toBeUndefined();
    expect(context.next?.slug).toBe("models/cloud");
    expect(pageContext(nav, "models/cloud").prev?.slug).toBe("getting-started/install");
  });

  test("returns the section for the breadcrumb", () => {
    expect(pageContext(nav, "models/cloud").section?.title).toBe("모델");
  });
});

describe("navBlocks", () => {
  test("merges consecutive one-page sections into one untitled block", async () => {
    const { navBlocks } = await import("./nav");
    const flat = (id: string) => ({ id, title: id, flat: true, rows: [] }) as never;
    const titled = (id: string) => ({ id, title: id, flat: false, rows: [] }) as never;
    const blocks = navBlocks([titled("a"), flat("b"), flat("c"), titled("d"), flat("e")]);
    expect(blocks.map((block) => [block.title, block.hideTitle, block.sections.length])).toEqual([
      ["a", false, 1],
      ["b · c", true, 2],
      ["d", false, 1],
      ["e", true, 1],
    ]);
  });
});
