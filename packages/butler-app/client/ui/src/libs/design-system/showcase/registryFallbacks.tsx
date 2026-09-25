import { designSystemBlocks, designSystemComponents } from "../registry";
import { legacyShowcaseCategories } from "./legacyCategories";
import type { ShowcaseModule } from "./types";

// Temporary adapter: registry.tsx fixtures keep rendering in the DS Viewer
// until each folder gains its own `<Name>.showcase.tsx`, which then wins.
export const registryFallbacks: Record<string, ShowcaseModule> = Object.fromEntries(
  [...designSystemComponents, ...designSystemBlocks].map((item) => [
    item.path,
    {
      meta: {
        title: item.name,
        category: legacyShowcaseCategories[item.path] ?? "Layout",
        tags: item.tags,
      },
      stories: [{ name: "Default", render: () => item.fixture() }],
    } satisfies ShowcaseModule,
  ]),
);
