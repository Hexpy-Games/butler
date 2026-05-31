import type { LocalePatterns } from "./types.ts";
import en from "./en.ts";
import ko from "./ko.ts";

// Add new locales here — just import and add to the array
const locales: LocalePatterns[] = [en, ko];

/** Merged patterns from all loaded locales */
export const DECISION_PATTERNS: RegExp[] = locales.flatMap(l => l.decision);
export const CONCEPT_PATTERNS: RegExp[] = locales.flatMap(l => l.concept);
export const INTEREST_PATTERNS: RegExp[] = locales.flatMap(l => l.interest);

export type { LocalePatterns };
