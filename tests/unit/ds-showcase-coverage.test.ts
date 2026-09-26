import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  SHOWCASE_BLOCK_CATEGORIES,
  SHOWCASE_COMPONENT_CATEGORIES,
} from "../../packages/butler-app/client/ui/src/libs/design-system/showcase/categories.ts";
import type { ShowcaseModule } from "../../packages/butler-app/client/ui/src/libs/design-system/showcase/types.ts";

// Every design-system component and block folder owns a co-located
// `<Name>.showcase.tsx` and a README, and is exported from the public barrel.
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
