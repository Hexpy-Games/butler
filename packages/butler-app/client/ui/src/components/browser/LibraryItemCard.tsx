import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { notifyStatus } from "@/app/notifications";
import type { LibraryItem } from "./libraryStore";
import { browserCall, openBrowser } from "./browserBridge";
import { openScrap } from "./ScrapViewer";
/** Opens an item: a scrap with an HTML copy shows exactly its clipped part; `source` (or no copy) opens the page. */
export async function openLibraryItem(item: LibraryItem, source = false) {
  try {
    if (!source && item.kind === "scrap" && item.snapshot) { openScrap(item); return; }
    if (item.file) {
      if (item.session) useButlerStore.getState().openSession(item.session);
      useButlerStore.getState().openArtifact(item.id, { id: item.id, session_id: item.session as string, kind: "document", title: item.title, file_id: item.file.file_id, url: item.file.url, size_bytes: item.file.size_bytes, created_at: item.capturedAt }); return;
    }
    const url = item.output ? (await api<{ url:string }>(`/outputs/${item.output}/view`)).url : item.url;
    await openBrowser(); const id = await browserCall("create", { url }); if (id) await browserCall("activate", { id });
  } catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
}
export { LibraryItemCard } from "../library/LibraryItemCard";
