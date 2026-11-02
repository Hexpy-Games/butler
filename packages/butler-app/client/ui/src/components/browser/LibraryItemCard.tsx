import { openDocument } from "../documents/documentApi";
import { documentKind } from "../library/documentKinds";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { notifyStatus } from "@/app/notifications";
import type { LibraryItem } from "./libraryStore";
import { openLink } from "./browserBridge";
import { hasWebSource } from "../library/libraryActions";
import { openDetail } from "../library/libraryNav";
import { openScrap } from "./ScrapViewer";
import { openLibraryArtifact, openLibraryFile } from "../library/libraryFiles";
/** Opens an item: a scrap with an HTML copy shows exactly its clipped part; `source` (or no copy) opens the page. */
export async function openLibraryItem(item: LibraryItem, source = false) {
  try {
    if (item.block && item.origin) {
      if (source && item.origin.document) openDocument({ id: item.origin.document, title: item.title });
      else if (source) useButlerStore.getState().openSession(item.origin.session);
      else openDetail(item, { kind: "library", section: "scrap" });
      return;
    }
    if (source && item.session && (item.file || item.output || documentKind(item))) {
      useButlerStore.getState().openSession(item.session); return;
    }
    const document = documentKind(item);
    if (document) { if (source) await document.source(item); else await document.open(item); return; }
    if (!source && item.kind === "scrap" && item.snapshot) { openScrap(item); return; }
    if (item.file) { openLibraryFile(item); return; }
    if (!source && item.output) {
      openLibraryArtifact({ id: item.output, session_id: item.session, kind: "web", title: item.title, created_at: item.capturedAt }); return;
    }
    if (!item.output && !hasWebSource(item)) return;
    const url = item.output ? (await api<{ url:string }>(`/outputs/${item.output}/view`)).url : item.url;
    await openLink(url);
  } catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
}
export { LibraryItemCard } from "../library/LibraryItemCard";
