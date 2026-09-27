import { PATTERNS } from "./patterns";
import type { ViewerPage } from "./viewerNavigation";

export interface TrailStep {
  label: string;
  page?: string;
}

/** Where a page sits, for the toolbar breadcrumb. */
export function pageTrail(page: ViewerPage): TrailStep[] {
  const home = { label: "Butler DS", page: "overview" };
  switch (page.kind) {
    case "overview": return [home, { label: "Overview" }];
    case "guide": return [home, { label: "Decision guide" }];
    case "recipes": return [home, { label: "Build a screen" }];
    case "foundations": return [home, { label: "Foundations" }];
    case "foundation": return [home, { label: "Foundations", page: "foundations" }, { label: `${page.chapter.number} ${page.chapter.title}` }];
    case "motion": return [home, { label: "Foundations", page: "foundations" }, { label: "08 Motion" }];
    case "gallery": return [home, { label: page.section === "components" ? "Components" : "Blocks" }];
    case "patterns": return [home, { label: "Patterns" }];
    case "pattern": return [home, { label: "Patterns", page: "patterns" }, { label: PATTERNS.find((item) => item.id === page.id)?.title ?? page.id }];
    case "icons": return [home, { label: "Icons" }];
    case "item": {
      const section = page.entry.kind === "component" ? "components" : "blocks";
      return [home, { label: section === "components" ? "Components" : "Blocks", page: section },
        { label: page.entry.meta.category, page: section }, { label: page.entry.meta.title }];
    }
    case "not-found": return [home, { label: "Not found" }];
  }
}
