// Foundations read as a numbered guidebook. A chapter is an editorial page
// over one or more token categories; the tokens themselves still come from
// tokens.css (tokenCatalog), chapters only decide where each one is taught.
import type { TokenCategory, TokenEntry } from "./tokenCatalog";

export type FoundationChapterId =
  | "color" | "typography" | "spacing" | "sizing" | "radius" | "iconography" | "focus" | "motion" | "z-index" | "layout";

export interface FoundationChapter {
  id: FoundationChapterId;
  number: string;
  title: string;
  /** One line: what the chapter teaches. */
  summary: string;
  /** Token categories this chapter owns (its "All tokens" table). */
  categories: TokenCategory[];
  /** Narrow a category to some groups (Iconography shows only the icon sizes). */
  groups?: string[];
}

export const FOUNDATION_CHAPTERS: FoundationChapter[] = [
  { id: "color", number: "01", title: "Color", categories: ["color"],
    summary: "Neutral ramps, one accent, status pairs; every role graded for contrast in both themes." },
  { id: "typography", number: "02", title: "Typography", categories: ["typography"],
    summary: "One system voice for Latin and Hangul, a role scale instead of sizes, calm weights." },
  { id: "spacing", number: "03", title: "Spacing", categories: ["spacing", "settings"],
    summary: "A 4px-based named scale, page widths and the settings rhythm." },
  { id: "sizing", number: "04", title: "Sizing", categories: ["sizing"],
    summary: "Control heights, hit targets and chrome dimensions." },
  { id: "radius", number: "05", title: "Radius and elevation", categories: ["radius", "shadow"],
    summary: "Corners grow with the surface; shadows stay soft and few." },
  { id: "iconography", number: "06", title: "Iconography", categories: ["sizing"], groups: ["Icons"],
    summary: "Six icon sizes, paired with the type role they sit beside." },
  { id: "focus", number: "07", title: "Focus ring", categories: ["focus"],
    summary: "One accent ring on every focusable control, drawn on :focus-visible." },
  { id: "motion", number: "08", title: "Motion", categories: ["motion"],
    summary: "Linear-crisp: short decelerating entrances, faster exits." },
  { id: "z-index", number: "09", title: "Layers", categories: ["z-index"],
    summary: "The stacking order, from drop hints to the drag ghost." },
  { id: "layout", number: "10", title: "Layout and platform", categories: ["layout"],
    summary: "Safe areas, dialog widths and component geometry the shell reads." },
];

/** Category routes that open another chapter (foundations/shadow → Radius and elevation). */
const CATEGORY_CHAPTER: Partial<Record<TokenCategory, FoundationChapterId>> = { shadow: "radius", settings: "spacing" };

export function chapterById(id: string): FoundationChapter | undefined {
  const alias = CATEGORY_CHAPTER[id as TokenCategory];
  return FOUNDATION_CHAPTERS.find((chapter) => chapter.id === (alias ?? id));
}

/** The chapter a token is taught in (search results and token chips link there). */
export function chapterForToken(token: Pick<TokenEntry, "category" | "group">): FoundationChapter {
  return FOUNDATION_CHAPTERS.find((chapter) => !chapter.groups && chapter.categories.includes(token.category))
    ?? FOUNDATION_CHAPTERS[0]!;
}

/** The chapter's page id: Motion lives on its own live page. */
export function chapterPage(chapter: FoundationChapter): string {
  return chapter.id === "motion" ? "motion" : `foundations/${chapter.id}`;
}

export function chapterTokens(catalog: TokenEntry[], chapter: FoundationChapter): TokenEntry[] {
  return catalog.filter((token) => chapter.categories.includes(token.category) && (!chapter.groups || chapter.groups.includes(token.group)));
}
