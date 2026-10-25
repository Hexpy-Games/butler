import { useFileViewerState } from "../../app/fileViewerState";
import { api } from "../../app/api";
import { libraryChanged } from "../../app/libraryEvents";
import { useButlerStore } from "../../app/store";
export interface DocumentAsset { id: string; url: string; signed_url?: string; image_width?: number; image_height?: number }
export interface DocumentRevision { rev: number; author: "user" | "butler"; created_at: string; updated_at: string }
export interface EditableDocument extends DocumentRevision {
  id: string; title: string; body: string; chat_id?: string; message_id?: string; assets?: DocumentAsset[];
}
export const documentPath = (id: string) => `/documents/${encodeURIComponent(id)}`;
export const readDocument = (id: string, rev?: number) => api<EditableDocument>(`${documentPath(id)}${rev ? `/revisions/${rev}` : ""}`);
export const revisions = (id: string) => api<DocumentRevision[]>(`${documentPath(id)}/revisions`);
export async function restoreDocument(id: string, rev: number) {
  for (;;) {
    const head = await readDocument(id);
    try {
      const result = await api<EditableDocument>(`${documentPath(id)}/restore`, { method: "POST", body: JSON.stringify({ rev, expected_rev: head.rev, author: "user" }) });
      libraryChanged(); return result;
    } catch (error) { if ((error as { code?: string }).code !== "revision_conflict") throw error; }
  }
}
/** Chat documents share the file viewer; drawer opens retain their full-page reader. */
export function openDocument(doc: Pick<EditableDocument, "id" | "title" | "chat_id" | "message_id">) {
  const store = useButlerStore.getState();
  if (doc.chat_id && store.view.kind === "session") {
    useFileViewerState.getState().open(doc.chat_id, { kind: "document", id: doc.id, title: doc.title });
    return;
  }
  store.setView({ kind: "library", section: "document", doc: doc.id });
}
