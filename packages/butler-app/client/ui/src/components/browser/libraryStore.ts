import type { AnswerBlocksView } from "../../../../shared/answer-blocks-view";
import { useCallback, useEffect, useState } from "react";
import { libraryChanged, useLibraryVersion } from "@/app/libraryEvents";
import { assetSource } from "../images/imageApi";
import { api, uploadMessageFile } from "@/app/api";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import type { ElementFileRef } from "../../../../shared/browser-element";
import { messageFileUrl } from "../conversation/messageMedia";
import { attachElements, attachLibraryReference, type PickedElement, type ScrapSnapshot } from "./browserElements";
import type { ArtifactRevision, LibraryKind } from "@/app/types";
export type { LibraryKind } from "@/app/types";
/** The structured fields of a scrap saved from an answer (a card, a gallery item), kept beside its copy. */
export interface ScrapFields { title?: string; sub?: string; label?: string; value?: unknown; facts?: string[]; text?: string; source?: string; checked?: string }
/** A saved item. `group` is its scrap group or bookmark folder id; `tags` are shared across kinds; `autoTitle` is the name it had before a rename. */
export type LibraryItem = Partial<PickedElement> & { id: string; asset?: string; image_url?: string; kind: LibraryKind | "doc"; author?: "user" | "butler"; updatedAt?: string; rev?: number; title: string; url: string; capturedAt: string; file?: ElementFileRef; output?: string; folder?: string; session?: string; snapshot?: ScrapSnapshot; group?: string | null; tags?: string[]; autoTitle?: string; fields?: ScrapFields; block?: AnswerBlocksView; origin?: { document?: string; session: string; message: string; path: string; id?: string }; revisions?: ArtifactRevision[] };
/** Signed library asset URLs keep originals referenced; crops retain their own stored preview. */
export function libraryImageSource(item: LibraryItem, width?: number): string | undefined {
  return item.asset && item.image_url ? assetSource({ image_url: item.image_url }, width) : item.crop;
}
type Page = { items: LibraryItem[]; next_cursor?: string | null };
export async function saveLibrary(item: LibraryItem) {
  const saved = await api<LibraryItem>("/library", { method: "POST", body: JSON.stringify(item) }); libraryChanged(); return saved;
}
/** A scrap's stored HTML copy (null when it has none). */
export async function librarySnapshot(id: string) {
  return (await api<{ html: string | null }>(`/library/${encodeURIComponent(id)}/snapshot`)).html;
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
  if (item.kind === "scrap" && !item.block) await attachElements(session, [item as PickedElement]);
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
