import { relativeAge } from "@/app/utils";
import type { LibraryItem } from "../browser/libraryStore";
import { openDocument } from "../documents/documentApi";
import { useButlerStore } from "@/app/store";
import { appCopy } from "@/app/copy";
import { openLibraryFile } from "./libraryFiles";
/** Document section presentation and opening policy; file and editable histories stay independent. */
const documentKinds = {
  doc: { media: { kind: "document" as const }, meta: (item: LibraryItem) => `${relativeAge(item.updatedAt ?? item.capturedAt)} · ${item.author === "butler" ? appCopy.documents.butler : appCopy.documents.me}`,
    open: (item: LibraryItem) => openDocument({ id: item.id, title: item.title, chat_id: item.session }),
    source: (item: LibraryItem) => { if (item.session) useButlerStore.getState().openSession(item.session); } },
  document: { media: { kind: "document" as const }, meta: undefined, open: openLibraryFile, source: (item: LibraryItem) => { if (item.session) useButlerStore.getState().openSession(item.session); else openLibraryFile(item); } },
};
export const documentKind = (item: LibraryItem) => item.kind === "doc" || item.kind === "document" ? documentKinds[item.kind] : undefined;
