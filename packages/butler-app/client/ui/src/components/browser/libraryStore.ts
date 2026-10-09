import { useCallback, useEffect, useState } from "react";
import { libraryChanged, useLibraryVersion } from "@/app/libraryEvents";
import { api, uploadMessageFile } from "@/app/api";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import type { ElementFileRef } from "../../../../shared/browser-element";
import { messageFileUrl } from "../conversation/messageMedia";
import { attachElements, attachLibraryReference, type PickedElement } from "./browserElements";
export type LibraryKind = "scrap" | "document" | "bookmark" | "output";
export type LibraryItem = Partial<PickedElement> & { id: string; kind: LibraryKind; title: string; url: string; capturedAt: string; file?: ElementFileRef; output?: string; folder?: string; session?: string };
type Page = { items: LibraryItem[]; next_cursor?: string | null };
export async function saveLibrary(item: LibraryItem) {
  const saved = await api<LibraryItem>("/library", { method: "POST", body: JSON.stringify(item) }); libraryChanged(); return saved;
}
export async function deleteLibrary(id: string) { await api(`/library/${encodeURIComponent(id)}`, { method: "DELETE" }); libraryChanged(); }
/** Keyset pages; late searches cannot replace the latest query. No polling. */
export function useLibraryPage(kind: LibraryKind, q = "") {
  const version = useLibraryVersion(s => s.version);
  const [page, setPage] = useState<Page>({ items: [] });
  const [failed, setFailed] = useState(false), [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState("");
  useEffect(() => { setCursor(""); setPage({ items: [] }); }, [kind, q, version]);
  useEffect(() => {
    let active = true; setLoading(true); setFailed(false);
    void api<Page>(`/library?${new URLSearchParams({ kind, q, cursor })}`).then(next => {
      if (active) setPage(prior => ({ ...next, items: cursor ? [...prior.items, ...next.items] : next.items }));
    }, () => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [kind, q, cursor, version]);
  const more = useCallback(() => { if (!loading && page.next_cursor) setCursor(page.next_cursor); }, [loading, page.next_cursor]);
  return { ...page, failed, loading, more };
}
export function useBookmark(url?: string) {
  const version = useLibraryVersion(s => s.version);
  const [bookmark, setBookmark] = useState<LibraryItem>();
  useEffect(() => {
    let active = true; setBookmark(undefined);
    if (url) void api<{ item?:LibraryItem }>(`/library?${new URLSearchParams({ url: new URL(url).href })}`).then(v => { if (active) setBookmark(v.item); }, () => { if (active) setBookmark(undefined); });
    return () => { active = false; };
  }, [url, version]);
  return bookmark;
}
export async function attachLibrary(session: string, item: LibraryItem) {
  if (item.kind === "scrap") await attachElements(session, [item as PickedElement]);
  else {
    let data: Blob, name: string;
    if (item.file) {
      const response = await fetch(messageFileUrl(item.file)); if (!response.ok) throw new Error("Saved file is unavailable.");
      data = await response.blob(); name = item.file.safe_name;
    } else { data = new Blob([JSON.stringify({ untrusted_content: { kind: "web_page_data", item } })], { type: "application/json" }); name = "bookmark.json"; }
    const file = await uploadMessageFile(new File([data], name, { type: data.type }), session);
    await attachLibraryReference(session, { kind: "library", id: item.id, title: item.title, site: item.site ?? appCopy.browser[item.kind === "output" ? "output" : item.kind === "document" ? "document" : "bookmarks"], file });
  }
  const store = useButlerStore.getState(); store.openSession(session);
  notifyStatus(appCopy.browser.attachToChat);
}
