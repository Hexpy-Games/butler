import {
  SHOWCASE_BLOCK_CATEGORIES,
  SHOWCASE_COMPONENT_CATEGORIES,
  type ShowcaseCategory,
} from "../showcase/categories";
import type { ShowcaseEntry, ShowcaseKind } from "../showcase/collectShowcaseEntries";

export type GallerySection = "components" | "blocks";
export type PlaceholderSection = "patterns" | "icons";

export type ViewerPage =
  | { kind: "overview" }
  | { kind: "foundations" }
  | { kind: "gallery"; section: GallerySection }
  | { kind: "placeholder"; section: PlaceholderSection }
  | { kind: "item"; entry: ShowcaseEntry }
  | { kind: "not-found"; id: string };

export interface ViewerNavGroup {
  category: ShowcaseCategory;
  entries: ShowcaseEntry[];
}

export function resolveViewerPage(pageId: string, entries: ShowcaseEntry[]): ViewerPage {
  if (pageId === "overview") return { kind: "overview" };
  if (pageId === "foundations") return { kind: "foundations" };
  if (pageId === "components" || pageId === "blocks") return { kind: "gallery", section: pageId };
  if (pageId === "patterns" || pageId === "icons") return { kind: "placeholder", section: pageId };
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
  return [entry.name, entry.meta.title, entry.meta.category, ...(entry.meta.tags ?? [])]
    .join(" ")
    .toLowerCase();
}

/** Every whitespace-separated term must appear in the name, tags, or category. */
export function filterEntries(entries: ShowcaseEntry[], query: string): ShowcaseEntry[] {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const text = haystack(entry);
    return terms.every((term) => text.includes(term));
  });
}
