import {
  SHOWCASE_BLOCK_CATEGORIES,
  SHOWCASE_COMPONENT_CATEGORIES,
  type ShowcaseCategory,
} from "../showcase/categories";
import type { ShowcaseEntry, ShowcaseKind } from "../showcase/collectShowcaseEntries";
import { chapterById, type FoundationChapter } from "./foundations/chapters";

export type GallerySection = "components" | "blocks";

export type ViewerPage =
  | { kind: "overview" }
  | { kind: "guide" }
  | { kind: "recipes" }
  | { kind: "foundations" }
  | { kind: "foundation"; chapter: FoundationChapter }
  | { kind: "motion" }
  | { kind: "gallery"; section: GallerySection }
  | { kind: "patterns" }
  | { kind: "pattern"; id: string }
  | { kind: "icons" }
  | { kind: "item"; entry: ShowcaseEntry }
  | { kind: "not-found"; id: string };

export interface ViewerNavGroup {
  category: ShowcaseCategory;
  entries: ShowcaseEntry[];
}

const FIXED: Record<string, ViewerPage> = {
  overview: { kind: "overview" },
  guide: { kind: "guide" },
  recipes: { kind: "recipes" },
  foundations: { kind: "foundations" },
  motion: { kind: "motion" },
  components: { kind: "gallery", section: "components" },
  blocks: { kind: "gallery", section: "blocks" },
  patterns: { kind: "patterns" },
  icons: { kind: "icons" },
};

export function resolveViewerPage(pageId: string, entries: ShowcaseEntry[], patternIds: readonly string[] = []): ViewerPage {
  const fixed = FIXED[pageId];
  if (fixed) return fixed;
  // Chapters, plus the category routes they absorbed (foundations/shadow, foundations/settings).
  const chapterId = /^foundations\/(.+)$/u.exec(pageId)?.[1];
  const chapter = chapterId ? chapterById(chapterId) : undefined;
  if (chapter) return chapter.id === "motion" ? { kind: "motion" } : { kind: "foundation", chapter };
  const pattern = /^patterns\/(.+)$/u.exec(pageId)?.[1];
  if (pattern && patternIds.includes(pattern)) return { kind: "pattern", id: pattern };
  const lower = pageId.toLowerCase();
  const entry = entries.find((item) => item.id === pageId)
    ?? entries.find((item) => item.id.toLowerCase() === lower || item.name.toLowerCase() === lower);
  return entry ? { kind: "item", entry } : { kind: "not-found", id: pageId };
}

export function groupEntries(entries: ShowcaseEntry[], kind: ShowcaseKind): ViewerNavGroup[] {
  const categories: readonly ShowcaseCategory[] = kind === "component"
    ? SHOWCASE_COMPONENT_CATEGORIES
    : SHOWCASE_BLOCK_CATEGORIES;
  return categories
    .map((category) => ({
      category,
      entries: entries.filter((entry) => entry.kind === kind && entry.meta.category === category),
    }))
    .filter((group) => group.entries.length > 0);
}

function haystack(entry: ShowcaseEntry): string {
  return [
    entry.name, entry.meta.title, entry.meta.category, ...(entry.meta.tags ?? []),
    entry.guidance?.purpose ?? "", ...(entry.guidance?.whenToUse ?? []),
  ].join(" ").toLowerCase();
}

/** Every whitespace-separated term must appear in the name, tags, category or guidance. */
export function filterEntries(entries: ShowcaseEntry[], query: string): ShowcaseEntry[] {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const text = haystack(entry);
    return terms.every((term) => text.includes(term));
  });
}
