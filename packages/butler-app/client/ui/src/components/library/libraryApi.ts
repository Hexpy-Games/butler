import { useCallback, useEffect, useState } from "react";
import { api } from "@/app/api";
import { libraryChanged, useLibraryVersion } from "@/app/libraryEvents";
import type { LibraryKind } from "@/app/types";
import type { LibraryItem } from "../browser/libraryStore";

export type GroupKind = "scrap" | "bookmark";
export const hasGroups = (kind: LibraryKind): kind is GroupKind => kind === "scrap" || kind === "bookmark";

export interface LibraryGroup { id: string; kind: GroupKind; name: string; position: number; count: number; updatedAt: string; recent: LibraryItem[] }
export interface LibraryGroups { groups: LibraryGroup[]; ungrouped: number; total: number }
export interface TagCount { name: string; count: number }
export interface LibraryFacets { total: number; ungrouped: number | null; tags: TagCount[]; sites: Array<{ site: string; count: number }> }
export type LibrarySort = "new" | "old" | "name" | "site";
export type DatePreset = "today" | "week" | "month" | "year";
/** What a list shows: the kind, a group ("none" = ungrouped) and the filters, all AND. */
export interface LibraryQuery { kind: LibraryKind; group?: string; q?: string; tags?: readonly string[]; site?: string; date?: DatePreset; sort?: LibrarySort }

export function sinceFor(date: DatePreset | undefined, now = new Date()): string | undefined {
  if (!date) return undefined;
  const start = new Date(now);
  if (date === "today") start.setHours(0, 0, 0, 0);
  if (date === "week") start.setDate(start.getDate() - 7);
  if (date === "month") start.setDate(start.getDate() - 30);
  if (date === "year") { start.setMonth(0, 1); start.setHours(0, 0, 0, 0); }
  return start.toISOString();
}

export function queryString(query: LibraryQuery, cursor = "") {
  const params = new URLSearchParams({ kind: query.kind });
  if (query.group) params.set("group", query.group);
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.tags?.length) params.set("tags", query.tags.join(","));
  if (query.site) params.set("site", query.site);
  const since = sinceFor(query.date);
  if (since) params.set("since", since);
  if (query.sort && query.sort !== "new") params.set("sort", query.sort);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

/** One GET that refreshes on Library changes (saves, organizes, delivered turns); no polling. */
function useLibraryRead<T>(path: string | null, empty: T) {
  const version = useLibraryVersion((s) => s.version);
  const [state, setState] = useState<{ path: string | null; data: T; failed: boolean; loading: boolean }>({ path: null, data: empty, failed: false, loading: true });
  useEffect(() => {
    if (!path) return;
    let active = true;
    setState((prior) => ({ ...prior, loading: true, failed: false }));
    api<T>(path).then((data) => { if (active) setState({ path, data, failed: false, loading: false }); },
      () => { if (active) setState((prior) => ({ ...prior, failed: true, loading: false })); });
    return () => { active = false; };
  }, [path, version]);
  return { ...state.data as T, data: state.data, failed: state.failed, loading: state.loading || state.path !== path };
}

export const useLibraryGroups = (kind: GroupKind | null) =>
  useLibraryRead<LibraryGroups>(kind ? `/library/groups?kind=${kind}` : null, { groups: [], ungrouped: 0, total: 0 });
export const useLibraryFacets = (kind: LibraryKind, group?: string) =>
  useLibraryRead<LibraryFacets>(`/library/facets?${new URLSearchParams({ kind, ...(group ? { group } : {}) })}`, { total: 0, ungrouped: null, tags: [], sites: [] });
export const useLibraryTags = () => useLibraryRead<{ tags: TagCount[] }>("/library/tags", { tags: [] });

/** Keyset pages of one query; a newer query never shows an older answer. */
export function useLibraryItems(query: LibraryQuery, enabled = true) {
  const version = useLibraryVersion((s) => s.version);
  const key = queryString(query);
  const [page, setPage] = useState<{ key: string; items: LibraryItem[]; next: string | null }>({ key: "", items: [], next: null });
  const [cursor, setCursor] = useState(""), [loading, setLoading] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { setCursor(""); }, [key, version]);
  useEffect(() => {
    if (!enabled) return;
    let active = true; setLoading(true); setFailed(false);
    api<{ items: LibraryItem[]; next_cursor?: string | null }>(`/library?${queryString(query, cursor)}`).then((next) => {
      if (!active) return;
      setPage((prior) => ({ key, items: cursor && prior.key === key ? [...prior.items, ...next.items] : next.items, next: next.next_cursor ?? null }));
    }, () => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // The query is fully described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cursor, version, enabled]);
  const more = useCallback(() => { if (!loading && page.next) setCursor(page.next); }, [loading, page.next]);
  const items = page.key === key ? page.items : [];
  return { items, next: page.key === key ? page.next : null, loading: loading || page.key !== key, failed, more };
}

async function send<T>(path: string, method: string, body?: unknown) {
  const result = await api<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  libraryChanged();
  return result;
}
export const createGroup = (kind: GroupKind, name: string) => send<LibraryGroup>("/library/groups", "POST", { kind, name });
export const renameGroup = (id: string, name: string) => send<LibraryGroup>(`/library/groups/${encodeURIComponent(id)}`, "PATCH", { name });
export const moveGroup = (id: string, position: number) => send<LibraryGroup>(`/library/groups/${encodeURIComponent(id)}`, "PATCH", { position });
export const deleteGroup = (id: string) => send(`/library/groups/${encodeURIComponent(id)}`, "DELETE");
export interface ItemsPatch { ids: string[]; group?: string | null; addTags?: string[]; removeTags?: string[]; title?: string }
export const patchItems = (patch: ItemsPatch) => send<{ items: LibraryItem[] }>("/library/items", "PATCH", patch);
export const renameTag = (from: string, to: string) => send<{ tag: TagCount; merged: boolean }>("/library/tags", "PATCH", { from, to });
export const deleteTag = (name: string) => send(`/library/tags/${encodeURIComponent(name)}`, "DELETE");
export const errorCode = (error: unknown) => (error as { code?: string } | null)?.code;
