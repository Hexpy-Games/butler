import { collectShowcaseEntries } from "./collectShowcaseEntries";
import { legacyShowcaseCategories } from "./legacyCategories";
import { registryFallbacks } from "./registryFallbacks";
import type { ShowcaseModule } from "./types";

// Co-located showcase files are collected automatically; no manual list.
const showcaseModules = import.meta.glob<ShowcaseModule>(
  "../{components,blocks}/*/*.showcase.tsx",
  { eager: true },
);

const readmeModules = import.meta.glob<string>(
  "../{components,blocks}/*/README.md",
  { eager: true, import: "default", query: "?raw" },
);

export const showcaseEntries = collectShowcaseEntries({
  showcaseModules,
  readmeModules,
  fallbacks: registryFallbacks,
  legacyCategories: legacyShowcaseCategories,
});
