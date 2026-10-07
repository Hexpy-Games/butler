// test-category: pure-logic
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { SHOWCASE_BLOCK_CATEGORIES, SHOWCASE_COMPONENT_CATEGORIES } from "../../packages/butler-app/client/ui/src/libs/design-system/showcase/categories.ts";
import type { ShowcaseGuidance, ShowcaseModule } from "../../packages/butler-app/client/ui/src/libs/design-system/showcase/types.ts";
import { chapterById, chapterForToken, chapterPage, chapterTokens, FOUNDATION_CHAPTERS } from "../../packages/butler-app/client/ui/src/libs/design-system/viewer/foundations/chapters";
import { paletteFamilies } from "../../packages/butler-app/client/ui/src/libs/design-system/viewer/foundations/paletteFamilies";
import { buildTokenCatalog, parseTokenDefinitions, TOKEN_CATEGORIES } from "../../packages/butler-app/client/ui/src/libs/design-system/viewer/foundations/tokenCatalog";
import { BUNDLED_FACES, fontFamilies, fontWeights, typefaceTitle, typeRoles, WEIGHT_AXIS } from "../../packages/butler-app/client/ui/src/libs/design-system/viewer/foundations/typeScale";

describe("ds-showcase-coverage.test.ts", () => {
// Every design-system component and block folder owns a co-located
// `<Name>.showcase.tsx`, `<Name>.guidance.tsx` and a README, and is exported
// from the public barrel.
// There is no gap baseline: the coverage is complete and must stay complete.

const uiRoot = resolve("packages/butler-app/client/ui");
const designSystemRoot = join(uiRoot, "src/libs/design-system");
const kinds = ["components", "blocks"] as const;

/** Interactive items whose item page must show a states matrix. */
const REQUIRES_STATE_MATRIX = [
  "components/Breadcrumb", "components/Button", "components/Card", "components/Clickable", "components/ColorSwatchInput",
  "components/CopyButton", "components/IconButton", "components/Input", "components/NativeSelect", "components/PillButton",
  "components/SegmentedControl", "components/Select", "components/Slider", "components/Switch", "components/Tabs",
  "components/Textarea", "blocks/ComposerControl", "blocks/DisclosureRow", "blocks/NavRow", "blocks/OptionMenu",
  "blocks/SplitButton", "blocks/ChoiceCard", "blocks/TabStrip",
];

function folderIds(): string[] {
  return kinds.flatMap((kind) =>
    readdirSync(join(designSystemRoot, kind))
      .filter((name) => statSync(join(designSystemRoot, kind, name)).isDirectory())
      .sort()
      .map((name) => `${kind}/${name}`),
  );
}

function showcasePath(id: string): string {
  return join(designSystemRoot, id, `${id.split("/")[1]}.showcase.tsx`);
}

function guidancePath(id: string): string {
  return join(designSystemRoot, id, `${id.split("/")[1]}.guidance.tsx`);
}

async function loadShowcases(): Promise<Array<{ id: string; module: ShowcaseModule }>> {
  return Promise.all(folderIds().map(async (id) => ({ id, module: (await import(showcasePath(id))) as ShowcaseModule })));
}

const EMPTY_PLACEHOLDER = /<([a-z][\w-]*)\b[^>]*\bdata-ds-fixture="[^"]*"[^>]*>\s*<\/\1>|<[a-z][\w-]*\b[^>]*\bdata-ds-fixture="[^"]*"[^>]*\/>/u;

function renderer() {
  const requireFromUi = createRequire(join(uiRoot, "package.json"));
  // Resolve React from the UI package so stories and renderer share one copy.
  const { createElement } = requireFromUi("react") as { createElement: (type: () => unknown) => unknown };
  const { renderToStaticMarkup } = requireFromUi("react-dom/server") as { renderToStaticMarkup: (node: unknown) => string };
  return (render: () => unknown) => renderToStaticMarkup(createElement(render));
}

// Catalog-wide tests import and render every DS item in one test (~1 s idle),
// which crosses the 5 s default on a loaded machine.
const CATALOG_TIMEOUT_MS = 30_000;

describe("design-system showcase coverage", () => {
  test("every component and block folder has a showcase and a README (no gaps)", () => {
    const missing = folderIds().filter((id) => !existsSync(showcasePath(id)) || !existsSync(join(designSystemRoot, id, "README.md")));
    expect(missing).toEqual([]);
    expect(folderIds().length).toBeGreaterThanOrEqual(113);
  });
  test("every folder is exported from the public barrel, and every barrel export has a showcase", () => {
    const barrel = readFileSync(join(designSystemRoot, "index.ts"), "utf8");
    const exported = [...barrel.matchAll(/from "\.\/((?:components|blocks)\/[^"/]+)"/gu)].map((match) => match[1]!);
    expect([...new Set(exported)].sort()).toEqual(folderIds().sort());
    expect(exported.filter((id) => !existsSync(showcasePath(id)))).toEqual([]);
  });

  test("showcase files export meta and uniquely named stories in a known category", async () => {
    for (const { id, module } of await loadShowcases()) {
      const categories: readonly string[] = id.startsWith("components/") ? SHOWCASE_COMPONENT_CATEGORIES : SHOWCASE_BLOCK_CATEGORIES;
      expect({ id, title: module.meta?.title?.trim() || null }).toEqual({ id, title: id.split("/")[1] });
      expect({ id, knownCategory: categories.includes(module.meta.category) }).toEqual({ id, knownCategory: true });
      const names = module.stories.map((story) => story.name);
      expect({ id, hasStories: names.length > 0 }).toEqual({ id, hasStories: true });
      expect({ id, names }).toEqual({ id, names: [...new Set(names)] });
    }
  });

  test("transient and inline status surfaces sit in the Feedback group", async () => {
    const category = async (id: string) => ((await import(showcasePath(id))) as ShowcaseModule).meta.category;
    expect({ toast: await category("components/Toast"), notice: await category("blocks/Notice"), emptyLine: await category("blocks/EmptyLine") })
      .toEqual({ toast: "Feedback", notice: "Feedback", emptyLine: "Conversation & Activity" });
  });

  test("no story renders an empty placeholder; English stories render no Korean copy", async () => {
    const render = renderer();
    const empty: string[] = [];
    const korean: string[] = [];
    for (const { id, module } of await loadShowcases()) {
      for (const story of module.stories) {
        for (const locale of ["en-US", "ko-KR"] as const) {
          const markup = render(() => story.render({ locale }));
          if (!markup.trim() || EMPTY_PLACEHOLDER.test(markup)) empty.push(`${id}#${story.name}`);
          if (locale === "en-US" && /[가-힣]/u.test(markup.replace(/<[^>]*>/gu, " "))) korean.push(`${id}#${story.name}`);
        }
      }
    }
    expect({ empty, korean }).toEqual({ empty: [], korean: [] });
  }, CATALOG_TIMEOUT_MS);

  test("every item has complete usage guidance that points at real exports and tokens", async () => {
    const render = renderer();
    const tokens = new Set(readFileSync(join(designSystemRoot, "tokens.css"), "utf8").match(/--[\w-]+(?=\s*:)/gu) ?? []);
    const known = new Set(folderIds().map((id) => id.split("/")[1]!));
    for (const id of folderIds()) {
      for (const key of Object.keys(await import(join(designSystemRoot, id, "index.ts")))) known.add(key);
    }
    const problems: string[] = [];
    for (const id of folderIds()) {
      const path = guidancePath(id);
      if (!existsSync(path)) { problems.push(`${id}: missing ${id.split("/")[1]}.guidance.tsx`); continue; }
      const source = readFileSync(path, "utf8");
      const { guidance } = (await import(path)) as { guidance?: ShowcaseGuidance };
      if (!guidance) { problems.push(`${id}: no guidance export`); continue; }
      const need = (ok: boolean, what: string) => { if (!ok) problems.push(`${id}: ${what}`); };
      need(guidance.purpose?.trim().length > 20, "purpose");
      need(guidance.whenToUse?.length > 0, "whenToUse");
      need(guidance.whenNotToUse?.length > 0, "whenNotToUse");
      need(guidance.recipes?.length > 0, "recipes");
      need(guidance.doDont?.length > 0, "doDont");
      need(guidance.content?.length > 0, "content guidelines");
      need(guidance.accessibility?.length > 0, "accessibility notes");
      need(guidance.tokens?.length > 0, "related tokens");
      for (const alternative of guidance.whenNotToUse ?? []) {
        need(known.has(alternative.use) || /^Typo\.\w+$/u.test(alternative.use), `alternative ${alternative.use} is not a DS export`);
      }
      for (const token of guidance.tokens ?? []) need(tokens.has(token), `token ${token} is not in tokens.css`);
      for (const recipe of guidance.recipes ?? []) {
        need(source.includes(`// #region recipe: ${recipe.name}\n`), `recipe "${recipe.name}" has no #region block`);
        const markup = render(() => recipe.render({ locale: "en-US" }));
        need(markup.length > 0 && !/[가-힣]/u.test(markup.replace(/<[^>]*>/gu, " ")), `recipe "${recipe.name}" renders`);
      }
      for (const pair of guidance.doDont ?? []) {
        need(render(() => pair.do.render({ locale: "en-US" })).length > 0 && render(() => pair.dont.render({ locale: "en-US" })).length > 0,
          `do/don't "${pair.do.caption}" renders`);
      }
    }
    expect(problems).toEqual([]);
  }, CATALOG_TIMEOUT_MS);

  test("every exported component is shown in a story, a recipe or a do/don't, or named as internal", async () => {
    const unreferenced: string[] = [];
    for (const id of folderIds()) {
      // Every icon renders in the Icons page gallery (IconGallery iterates the module).
      if (id === "components/Icons") continue;
      const name = id.split("/")[1]!;
      const sources = [`${name}.showcase.tsx`, `${name}.guidance.tsx`, `${name}.showcaseParts.tsx`]
        .map((file) => join(designSystemRoot, id, file)).filter(existsSync).map((file) => readFileSync(file, "utf8")).join("\n");
      const guidance = existsSync(guidancePath(id)) ? ((await import(guidancePath(id))) as { guidance?: ShowcaseGuidance }).guidance : undefined;
      for (const key of Object.keys(await import(join(designSystemRoot, id, "index.ts")))) {
        if (!/^[A-Z][a-z]/u.test(key)) continue;
        if (new RegExp(`\\b${key}\\b`, "u").test(sources) || guidance?.internalExports?.[key]) continue;
        unreferenced.push(`${id}: ${key}`);
      }
    }
    expect(unreferenced).toEqual([]);
  }, CATALOG_TIMEOUT_MS);

  test("interactive items ship a states matrix whose cells render", async () => {
    const render = renderer();
    const modules = new Map((await loadShowcases()).map(({ id, module }) => [id, module]));
    expect(REQUIRES_STATE_MATRIX.filter((id) => !modules.get(id)?.stateMatrix)).toEqual([]);
    for (const [id, module] of modules) {
      const matrix = module.stateMatrix;
      if (!matrix) continue;
      expect({ id, states: matrix.states.length > 1 }).toEqual({ id, states: true });
      for (const variant of matrix.variants ?? ["default"]) {
        for (const state of matrix.states) {
          expect({ id, variant, state, rendered: render(() => matrix.render({ locale: "en-US", state, variant })).length > 0 })
            .toEqual({ id, variant, state, rendered: true });
        }
      }
    }
  }, CATALOG_TIMEOUT_MS);
});
});

describe("chapters.test.ts", () => {
// test-category: pure-logic
const css = readFileSync(new URL("../../packages/butler-app/client/ui/src/libs/design-system/tokens.css", import.meta.url), "utf8");
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

  test("the typeface hero names the bundled face and its served weight axis", () => {
    const families = fontFamilies(byName.get("--font-body")!.light);
    expect(typefaceTitle(families)).toBe("Pretendard Variable");
    expect(BUNDLED_FACES["Pretendard Variable"]).toContain("45–920");
    expect(fontFamilies(byName.get("--font-family-code")!.light)[0]).toBe("IBM Plex Mono");
    // Official @font-face range is 45 920; samples stay inside it.
    expect(Math.min(...WEIGHT_AXIS)).toBe(45);
    expect(Math.max(...WEIGHT_AXIS)).toBe(920);
    // A stack without a bundled face still pairs the lead with a Hangul face.
    expect(typefaceTitle(["Inter", "Apple SD Gothic Neo"])).toBe("Inter + Apple SD Gothic Neo");
  });

  test("palette ramps group every numbered step", () => {
    const families = paletteFamilies(catalog);
    expect(families.map((family) => family.family)).toEqual(["grayscale", "blue", "green", "red", "amber"]);
    expect(families.find((family) => family.family === "grayscale")?.steps).toHaveLength(12);
  });

  test("ICON_SIZE mirrors --icon-size-* exactly", async () => {
    const { ICON_SIZE } = await import(resolve("packages/butler-app/client/ui/src/libs/design-system/components/Icons/Icons.tsx")) as { ICON_SIZE: Record<string, number> };
    for (const [size, px] of Object.entries(ICON_SIZE)) expect({ size, value: byName.get(`--icon-size-${size}`)?.light }).toEqual({ size, value: `${px}px` });
  });

  test("every token a guidebook page names exists in tokens.css", () => {
    const dir = new URL("../../packages/butler-app/client/ui/src/libs/design-system/viewer/foundations/", import.meta.url);
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
});
