import type { ShowcaseEntry } from "../showcase/collectShowcaseEntries";
import { decisionGuide } from "./decisionGuide";
import { chapterForToken, chapterPage, FOUNDATION_CHAPTERS } from "./foundations/chapters";
import type { TokenEntry } from "./foundations/tokenCatalog";
import { PATTERNS } from "./patterns";
import { RECIPES } from "./recipes";

export type SearchKind = "page" | "component" | "block" | "token" | "pattern" | "recipe" | "guide";

export interface SearchItem {
  id: string;
  kind: SearchKind;
  title: string;
  subtitle: string;
  /** Page id, optionally with `#anchor`. */
  target: string;
  text: string;
}

const PAGES: Array<[string, string, string]> = [
  ["overview", "Overview", "Start"], ["guide", "Decision guide", "I need X → use Y"], ["recipes", "Build a screen", "Recipes"],
  ["foundations", "Foundations", "The guidebook"], ["motion", "Motion", "Durations, easings and live demos"],
  ["components", "Components", "Gallery"], ["blocks", "Blocks", "Gallery"], ["patterns", "Patterns", "Composition patterns"],
  ["composer-decorations", "Composer decorations", "Interactive prototype"],
  ["icons", "Icons", "Icon set"],
];

export function tokenAnchor(name: string): string {
  return `token${name}`;
}

export function buildSearchIndex(entries: ShowcaseEntry[], tokens: TokenEntry[]): SearchItem[] {
  const items: SearchItem[] = PAGES.map(([id, title, subtitle]) => ({ id: `page:${id}`, kind: "page", title, subtitle, target: id, text: `${title} ${subtitle}` }));
  for (const chapter of FOUNDATION_CHAPTERS) {
    if (chapter.id === "motion") continue;
    items.push({ id: `page:foundations/${chapter.id}`, kind: "page", title: chapter.title, subtitle: `Foundations ${chapter.number}`, target: chapterPage(chapter), text: `${chapter.title} ${chapter.summary}` });
  }
  for (const entry of entries) {
    items.push({
      id: `entry:${entry.id}`, kind: entry.kind, title: entry.meta.title, subtitle: `${entry.kind === "component" ? "Component" : "Block"} · ${entry.meta.category}`,
      target: entry.id, text: [entry.name, entry.meta.category, ...(entry.meta.tags ?? []), entry.guidance?.purpose ?? ""].join(" "),
    });
  }
  for (const pattern of PATTERNS) {
    items.push({ id: `pattern:${pattern.id}`, kind: "pattern", title: pattern.title, subtitle: "Pattern", target: `patterns/${pattern.id}`, text: `${pattern.title} ${pattern.summary}` });
  }
  for (const recipe of RECIPES) {
    items.push({ id: `recipe:${recipe.id}`, kind: "recipe", title: recipe.title, subtitle: "Build a screen", target: `recipes#recipe-${recipe.id}`, text: `${recipe.title} ${recipe.description}` });
  }
  for (const token of tokens) {
    items.push({ id: `token:${token.name}`, kind: "token", title: token.name, subtitle: `Token · ${token.group}`, target: `${chapterPage(chapterForToken(token))}#${tokenAnchor(token.name)}`, text: `${token.name} ${token.group} ${token.light}` });
  }
  decisionGuide(entries).forEach((row, index) => {
    items.push({ id: `guide:${index}`, kind: "guide", title: `${row.need} → ${row.use}`, subtitle: "Decision guide", target: row.target, text: `${row.need} ${row.use}` });
  });
  return items;
}

const KIND_RANK: Record<SearchKind, number> = { page: 0, component: 1, block: 1, pattern: 2, recipe: 2, guide: 3, token: 4 };

/** Every term must match; titles that start with the query rank first. */
export function searchItems(items: SearchItem[], query: string, limit = 40): SearchItem[] {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return items.filter((item) => item.kind !== "token" && item.kind !== "guide").slice(0, limit);
  const first = terms[0]!;
  return items
    .filter((item) => {
      const text = `${item.title} ${item.text}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .map((item) => ({ item, score: (item.title.toLowerCase().startsWith(first) ? 0 : 10) + KIND_RANK[item.kind] }))
    .sort((left, right) => left.score - right.score)
    .slice(0, limit)
    .map(({ item }) => item);
}
