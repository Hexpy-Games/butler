import { describe, expect, test } from "bun:test";
import { buildNav, docHref, docSlug, pageContext, withBase, type DocEntryLike } from "./nav";

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
    expect(withBase("/", "docs/")).toBe("/docs/");
    expect(withBase("/butler", "/docs/")).toBe("/butler/docs/");
    expect(withBase("/butler/", "docs/a/")).toBe("/butler/docs/a/");
  });

  test("strips the locale from entry ids", () => {
    expect(docSlug("ko/getting-started/install")).toBe("getting-started/install");
  });

  test("keeps the default locale unprefixed", () => {
    expect(docHref("/butler/", "ko", "getting-started/install")).toBe("/butler/docs/getting-started/install/");
    expect(docHref("/", "en", "models/cloud")).toBe("/en/docs/models/cloud/");
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
    expect(install).toMatchObject({ href: "/docs/getting-started/install/", active: true, planned: false });
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
