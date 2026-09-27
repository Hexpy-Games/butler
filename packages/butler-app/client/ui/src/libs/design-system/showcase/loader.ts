import { collectShowcaseEntries } from "./collectShowcaseEntries";
import type { ShowcaseGuidance, ShowcaseModule } from "./types";

// Co-located showcase and guidance files are collected automatically; no manual list.
const showcaseModules = import.meta.glob<ShowcaseModule>(
  "../{components,blocks}/*/*.showcase.tsx",
  { eager: true },
);

const guidanceModules = import.meta.glob<{ guidance: ShowcaseGuidance }>(
  "../{components,blocks}/*/*.guidance.tsx",
  { eager: true },
);

// Raw guidance sources load on demand (item pages only) to show recipe JSX verbatim.
const guidanceSources = import.meta.glob<string>(
  "../{components,blocks}/*/*.guidance.tsx",
  { import: "default", query: "?raw" },
);

const readmeModules = import.meta.glob<string>(
  "../{components,blocks}/*/README.md",
  { eager: true, import: "default", query: "?raw" },
);

export const showcaseEntries = collectShowcaseEntries({
  showcaseModules,
  readmeModules,
  guidanceModules,
  guidanceSources,
});
