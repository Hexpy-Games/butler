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
import { storedFileArtifactKind } from "../artifacts/artifactDisplay";
/** Opens an item: a scrap with an HTML copy shows exactly its clipped part; `source` (or no copy) opens the page. */
export async function openLibraryItem(item: LibraryItem, source = false) {
  try {
    if (item.block && item.origin) {
      if (source && item.origin.document) openDocument({ id: item.origin.document, title: item.title });
      else if (source) useButlerStore.getState().openSession(item.origin.session);
      else openDetail(item, { kind: "library", section: "scrap" });
      return;
    }
    const document = documentKind(item);
    if (document) { if (source) await document.source(item); else await document.open(item); return; }
    if (!source && item.kind === "scrap" && item.snapshot) { openScrap(item); return; }
    if (item.file) {
      if (item.session) useButlerStore.getState().openSession(item.session);
      useButlerStore.getState().openArtifact({ id: item.id, session_id: item.session as string, kind: storedFileArtifactKind(item.file), title: item.title, file_id: item.file.file_id, url: item.file.url, size_bytes: item.file.size_bytes, created_at: item.capturedAt,
        safe_path_label: item.file.safe_name, source_label: item.revisions?.[0]?.file.source_label, revisions: item.revisions,
        deliverable: true }, item.session); return;
    }
    if (!item.output && !hasWebSource(item)) return;
    const url = item.output ? (await api<{ url:string }>(`/outputs/${item.output}/view`)).url : item.url;
    await openLink(url);
  } catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
}
export { LibraryItemCard } from "../library/LibraryItemCard";
