import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  SHOWCASE_BLOCK_CATEGORIES,
  SHOWCASE_COMPONENT_CATEGORIES,
} from "../../packages/butler-app/client/ui/src/libs/design-system/showcase/categories.ts";
import type { ShowcaseGuidance, ShowcaseModule } from "../../packages/butler-app/client/ui/src/libs/design-system/showcase/types.ts";

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
  "blocks/SessionRow", "blocks/SplitButton",
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

describe("design-system showcase coverage", () => {
  test("every component and block folder has a showcase and a README (no gaps)", () => {
    const missing = folderIds().filter((id) => !existsSync(showcasePath(id)) || !existsSync(join(designSystemRoot, id, "README.md")));
    expect(missing).toEqual([]);
    expect(folderIds().length).toBeGreaterThanOrEqual(118);
  });

  test("the legacy registry, category map and fixtures are gone", () => {
    expect(existsSync(join(designSystemRoot, "registry.tsx"))).toBe(false);
    expect(existsSync(join(designSystemRoot, "showcase/legacyCategories.ts"))).toBe(false);
    const fixtures = folderIds().filter((id) => readdirSync(join(designSystemRoot, id)).some((file) => file.includes(".fixtures.")));
    expect(fixtures).toEqual([]);
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
  });

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
  });

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
  });

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
  });
});
