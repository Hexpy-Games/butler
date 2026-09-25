import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  SHOWCASE_BLOCK_CATEGORIES,
  SHOWCASE_COMPONENT_CATEGORIES,
} from "../../packages/butler-app/client/ui/src/libs/design-system/showcase/categories.ts";
import { legacyShowcaseCategories } from "../../packages/butler-app/client/ui/src/libs/design-system/showcase/legacyCategories.ts";
import type { ShowcaseModule } from "../../packages/butler-app/client/ui/src/libs/design-system/showcase/types.ts";

// Every design-system component and block folder must own a co-located
// `<Name>.showcase.tsx` and a README. Known gaps are listed in the baseline
// JSON, which may only shrink: fixing a gap without removing it fails too.

const uiRoot = resolve("packages/butler-app/client/ui");
const designSystemRoot = join(uiRoot, "src/libs/design-system");
const baselinePath = resolve("tests/unit/ds-showcase-coverage-baseline.json");
const kinds = ["components", "blocks"] as const;

type Baseline = {
  missingShowcase: string[];
  missingReadme: string[];
  placeholderStories: string[];
};

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;

function folderIds(): string[] {
  return kinds.flatMap((kind) =>
    readdirSync(join(designSystemRoot, kind))
      .filter((name) => statSync(join(designSystemRoot, kind, name)).isDirectory())
      .sort()
      .map((name) => `${kind}/${name}`),
  );
}

function showcasePath(id: string): string {
  const name = id.split("/")[1];
  return join(designSystemRoot, id, `${name}.showcase.tsx`);
}

function missing(predicate: (id: string) => boolean): string[] {
  return folderIds().filter((id) => !predicate(id));
}

function expectShrinkOnly(label: string, current: string[], allowed: string[]) {
  const unexpected = current.filter((id) => !allowed.includes(id));
  const stale = allowed.filter((id) => !current.includes(id));
  expect({ label, newGaps: unexpected }).toEqual({ label, newGaps: [] });
  // A fixed gap must be removed from the baseline so the list only shrinks.
  expect({ label, fixedButStillListed: stale }).toEqual({ label, fixedButStillListed: [] });
}

const EMPTY_PLACEHOLDER = /<([a-z][\w-]*)\b[^>]*\bdata-ds-fixture="[^"]*"[^>]*>\s*<\/\1>|<[a-z][\w-]*\b[^>]*\bdata-ds-fixture="[^"]*"[^>]*\/>/u;

async function loadShowcases(): Promise<Array<{ id: string; module: ShowcaseModule }>> {
  const ids = folderIds().filter((id) => existsSync(showcasePath(id)));
  return Promise.all(ids.map(async (id) => ({
    id,
    module: (await import(showcasePath(id))) as ShowcaseModule,
  })));
}

describe("design-system showcase coverage", () => {
  test("baseline file is sorted and has no duplicates", () => {
    for (const list of [baseline.missingShowcase, baseline.missingReadme, baseline.placeholderStories]) {
      expect(list).toEqual([...new Set(list)].sort());
    }
  });

  test("every component and block folder has a showcase file (shrink-only baseline)", () => {
    expectShrinkOnly("missingShowcase", missing((id) => existsSync(showcasePath(id))), baseline.missingShowcase);
  });

  test("every component and block folder has a README (shrink-only baseline)", () => {
    expectShrinkOnly(
      "missingReadme",
      missing((id) => existsSync(join(designSystemRoot, id, "README.md"))),
      baseline.missingReadme,
    );
  });

  test("the temporary legacy category map covers exactly the folders without a showcase", () => {
    const withoutShowcase = missing((id) => existsSync(showcasePath(id)));
    expect(Object.keys(legacyShowcaseCategories).sort()).toEqual([...withoutShowcase].sort());
    for (const id of withoutShowcase) {
      const categories: readonly string[] = id.startsWith("components/")
        ? SHOWCASE_COMPONENT_CATEGORIES
        : SHOWCASE_BLOCK_CATEGORIES;
      expect({ id, knownCategory: categories.includes(legacyShowcaseCategories[id]) }).toEqual({ id, knownCategory: true });
    }
  });

  test("transient and inline status surfaces sit in the Feedback group", async () => {
    const toast = (await import(showcasePath("components/Toast"))) as ShowcaseModule;
    expect({
      toast: toast.meta.category,
      notice: legacyShowcaseCategories["blocks/Notice"],
      emptyLine: legacyShowcaseCategories["blocks/EmptyLine"],
    }).toEqual({ toast: "Feedback", notice: "Feedback", emptyLine: "Conversation & Activity" });
  });

  test("showcase files export meta and uniquely named stories in a known category", async () => {
    for (const { id, module } of await loadShowcases()) {
      const categories: readonly string[] = id.startsWith("components/")
        ? SHOWCASE_COMPONENT_CATEGORIES
        : SHOWCASE_BLOCK_CATEGORIES;
      expect({ id, title: module.meta?.title?.trim() || null }).toEqual({ id, title: id.split("/")[1] });
      expect({ id, knownCategory: categories.includes(module.meta.category) }).toEqual({ id, knownCategory: true });
      const names = module.stories.map((story) => story.name);
      expect({ id, hasStories: names.length > 0 }).toEqual({ id, hasStories: true });
      expect({ id, names }).toEqual({ id, names: [...new Set(names)] });
    }
  });

  test("no story renders an empty data-ds-fixture placeholder (shrink-only baseline)", async () => {
    const requireFromUi = createRequire(join(uiRoot, "package.json"));
    // Resolve React from the UI package so stories and renderer share one copy.
    const { createElement } = requireFromUi("react") as { createElement: (type: () => unknown) => unknown };
    const { renderToStaticMarkup } = requireFromUi("react-dom/server") as { renderToStaticMarkup: (node: unknown) => string };
    const placeholders: string[] = [];

    for (const { id, module } of await loadShowcases()) {
      for (const story of module.stories) {
        for (const locale of ["en-US", "ko-KR"] as const) {
          const markup = renderToStaticMarkup(createElement(() => story.render({ locale })));
          if (!markup.trim() || EMPTY_PLACEHOLDER.test(markup)) {
            placeholders.push(`${id}#${story.name}`);
            break;
          }
        }
      }
    }

    expectShrinkOnly("placeholderStories", placeholders, baseline.placeholderStories);
  });
  test("English stories render no Korean copy (example text follows the viewer locale)", async () => {
    const requireFromUi = createRequire(join(uiRoot, "package.json"));
    const { createElement } = requireFromUi("react") as { createElement: (type: () => unknown) => unknown };
    const { renderToStaticMarkup } = requireFromUi("react-dom/server") as { renderToStaticMarkup: (node: unknown) => string };
    const korean: string[] = [];
    for (const { id, module } of await loadShowcases()) {
      for (const story of module.stories) {
        const markup = renderToStaticMarkup(createElement(() => story.render({ locale: "en-US" })));
        if (/[\uAC00-\uD7A3]/u.test(markup.replace(/<[^>]*>/gu, " "))) korean.push(`${id}#${story.name}`);
      }
    }
    expect(korean).toEqual([]);
  });
});
