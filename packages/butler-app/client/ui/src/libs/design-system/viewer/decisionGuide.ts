import type { ShowcaseEntry } from "../showcase/collectShowcaseEntries";

export interface DecisionRow {
  need: string;
  /** Export name to use. */
  use: string;
  /** Page id of the item to open. */
  target: string;
  /** The item whose guidance produced the row ("instead of X"). */
  from?: string;
}

/** Resolves an alternative ("Button", "blocks/NavRow") to an entry. */
export function findEntry(entries: ShowcaseEntry[], name: string): ShowcaseEntry | undefined {
  return entries.find((entry) => entry.id === name || entry.name === name)
    ?? entries.find((entry) => name.startsWith(entry.name));
}

/**
 * "I need X -> use Y", generated from every item's guidance: each `whenToUse`
 * points at the item itself, each `whenNotToUse` at its alternative.
 */
export function decisionGuide(entries: ShowcaseEntry[]): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (const entry of entries) {
    for (const need of entry.guidance?.whenToUse ?? []) rows.push({ need, use: entry.name, target: entry.id });
    for (const alternative of entry.guidance?.whenNotToUse ?? []) {
      const target = findEntry(entries, alternative.use);
      rows.push({ need: alternative.when, use: alternative.use, target: target?.id ?? entry.id, from: entry.name });
    }
  }
  return rows.sort((left, right) => left.need.localeCompare(right.need));
}
