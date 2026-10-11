import { create } from "zustand";
import type { DatePreset, LibrarySort } from "./libraryApi";

/** The Library's search and filters; they apply on the main screen and in every kind view. */
export interface LibraryFilters { text: string; q: string; tags: string[]; site?: string; date?: DatePreset; since?: string; until?: string; sort: LibrarySort }
export const useLibraryFilters = create<LibraryFilters>(() => ({ text: "", q: "", tags: [], sort: "new" }));
export const filtersActive = (f: LibraryFilters) => Boolean(f.q.trim() || f.tags.length || f.site || f.date || f.since || f.until);
export const setFilters = (patch: Partial<LibraryFilters>) => useLibraryFilters.setState(patch);
export const clearFilters = () => { clearTimeout(searchTimer); useLibraryFilters.setState({ text: "", q: "", tags: [], site: undefined, date: undefined, since: undefined, until: undefined }); };
let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** Typing updates the field now and the query after a short pause (one request per pause, not per key). */
export function typeSearch(text: string) {
  useLibraryFilters.setState({ text });
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => useLibraryFilters.setState({ q: text }), 150);
}
