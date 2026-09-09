import { appCopy } from "@/app/copy.ts";
export function generalFallbackSuggestions() { return appCopy.briefing.general.suggestions; }
export function skillFallbackSuggestions(name: string) { return appCopy.briefing.skillSuggestions(name); }
export function projectFallbackSuggestions(name: string) { return appCopy.briefing.projectSuggestions(name); }
