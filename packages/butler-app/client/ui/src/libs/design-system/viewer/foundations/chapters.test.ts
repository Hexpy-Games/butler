/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ICON_SIZE } from "../../components/Icons/Icons";
import { chapterById, chapterForToken, chapterPage, chapterTokens, FOUNDATION_CHAPTERS } from "./chapters";
import { paletteFamilies } from "./paletteFamilies";
import { buildTokenCatalog, parseTokenDefinitions, TOKEN_CATEGORIES } from "./tokenCatalog";
import { fontFamilies, fontWeights, typeRoles } from "./typeScale";

const css = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");
const catalog = buildTokenCatalog(parseTokenDefinitions(css));
const byName = new Map(catalog.map((token) => [token.name, token]));

describe("foundations guidebook chapters", () => {
  test("every token category is taught by a chapter, and every token lands on one", () => {
    for (const category of TOKEN_CATEGORIES) {
      expect({ category, chapter: FOUNDATION_CHAPTERS.some((chapter) => !chapter.groups && chapter.categories.includes(category)) })
        .toEqual({ category, chapter: true });
    }
    const covered = new Set(FOUNDATION_CHAPTERS.flatMap((chapter) => chapterTokens(catalog, chapter).map((token) => token.name)));
    expect(covered.size).toBe(catalog.length);
    for (const token of catalog) expect(chapterTokens(catalog, chapterForToken(token)).includes(token)).toBe(true);
  });

  test("numbers chapters 01…10 and keeps the old category routes working", () => {
    expect(FOUNDATION_CHAPTERS.map((chapter) => chapter.number)).toEqual(FOUNDATION_CHAPTERS.map((_, index) => String(index + 1).padStart(2, "0")));
    for (const category of TOKEN_CATEGORIES) expect(chapterById(category)).toBeTruthy();
    expect(chapterById("shadow")?.id).toBe("radius");
    expect(chapterById("settings")?.id).toBe("spacing");
    expect(chapterPage(chapterById("motion")!)).toBe("motion");
    expect(chapterById("nope")).toBeUndefined();
  });
});

describe("specimens are derived from tokens.css", () => {
  test("the type ladder has a rung for every --typo-*-size role, largest first", () => {
    const sizes = catalog.filter((token) => /^--typo-.+-size$/u.test(token.name));
    const roles = typeRoles(catalog);
    expect(roles.map((role) => role.size.name).sort()).toEqual(sizes.map((token) => token.name).sort());
    for (const role of roles) expect({ role: role.role, weight: Boolean(role.weight), leading: Boolean(role.lineHeight) }).toEqual({ role: role.role, weight: true, leading: true });
    const px = roles.map((role) => Number.parseFloat(role.size.light));
    expect(px).toEqual([...px].sort((a, b) => b - a));
    expect(roles[0]?.role).toBe("new-chat-title");
  });

  test("weights and families come from the font tokens", () => {
    expect(fontWeights(catalog).map((token) => token.light)).toEqual(["400", "500", "560", "620"]);
    // The hero names whatever the stack is: families only, generic keywords dropped.
    const families = fontFamilies(byName.get("--font-body")!.light);
    expect(families.length).toBeGreaterThan(0);
    expect(families.some((family) => /^(ui-|system-ui|sans-serif|-apple-system|BlinkMacSystemFont)/u.test(family))).toBe(false);
  });

  test("palette ramps group every numbered step", () => {
    const families = paletteFamilies(catalog);
    expect(families.map((family) => family.family)).toEqual(["grayscale", "blue", "green", "red", "amber"]);
    expect(families.find((family) => family.family === "grayscale")?.steps).toHaveLength(12);
  });

  test("ICON_SIZE mirrors --icon-size-* exactly", () => {
    for (const [size, px] of Object.entries(ICON_SIZE)) expect({ size, value: byName.get(`--icon-size-${size}`)?.light }).toEqual({ size, value: `${px}px` });
  });

  test("every token a guidebook page names exists in tokens.css", () => {
    const dir = new URL("./", import.meta.url);
    const sources = readdirSync(dir).filter((file) => file.endsWith(".tsx") || file === "chapters.ts");
    const missing: string[] = [];
    for (const file of sources) {
      const source = readFileSync(new URL(file, dir), "utf8");
      for (const [name] of source.matchAll(/--[a-z][\w-]*[a-z0-9]/gu)) {
        if (/^--(sample|step|swatch|role|probe|depth|fraction|matrix|motion-duration|motion-easing|oneline)(-|$)/u.test(name)) continue;
        if (name.endsWith("-") || byName.has(name) || [...byName.keys()].some((token) => token.startsWith(`${name}-`))) continue;
        missing.push(`${file}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
