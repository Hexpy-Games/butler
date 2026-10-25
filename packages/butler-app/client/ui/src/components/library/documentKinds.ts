import { relativeAge } from "@/app/utils";
import type { LibraryItem } from "../browser/libraryStore";
import { openDocument } from "../documents/documentApi";
import { useButlerStore } from "@/app/store";
import { appCopy } from "@/app/copy";
import { storedFileArtifactKind } from "../artifacts/artifactDisplay";
function openFile(item: LibraryItem) {
  if (!item.file) return;
  if (item.session) useButlerStore.getState().openSession(item.session);
  useButlerStore.getState().openArtifact({ id: item.id, session_id: item.session, kind: storedFileArtifactKind(item.file), title: item.title, file_id: item.file.file_id, url: item.file.url, size_bytes: item.file.size_bytes, created_at: item.capturedAt,
    safe_path_label: item.file.safe_name, source_label: item.revisions?.[0]?.file.source_label, revisions: item.revisions }, item.session);
}
/** Document section presentation and opening policy; file and editable histories stay independent. */
const documentKinds = {
  doc: { media: { kind: "document" as const }, meta: (item: LibraryItem) => `${relativeAge(item.updatedAt ?? item.capturedAt)} · ${item.author === "butler" ? appCopy.documents.butler : appCopy.documents.me}`,
    open: (item: LibraryItem) => openDocument({ id: item.id, title: item.title, chat_id: item.session }),
    source: (item: LibraryItem) => { if (item.session) useButlerStore.getState().openSession(item.session); } },
  document: { media: { kind: "document" as const }, meta: undefined, open: openFile, source: openFile },
};
export const documentKind = (item: LibraryItem) => item.kind === "doc" || item.kind === "document" ? documentKinds[item.kind] : undefined;
