import { LIBRARY_VIEWER, useFileViewerState } from "@/app/fileViewerState";
import { useButlerStore } from "@/app/store";
import type { SessionArtifactSummary } from "@/app/types";
import { storedFileArtifactKind } from "../artifacts/artifactDisplay";
import type { LibraryItem } from "../browser/libraryStore";

/** The same file renderer, owned by the drawer while it is the current view. */
export function openLibraryArtifact(artifact: SessionArtifactSummary) {
  const store = useButlerStore.getState();
  if (store.view.kind === "library") {
    useFileViewerState.getState().open(LIBRARY_VIEWER, { kind: "artifact", id: artifact.id, artifact });
  } else {
    store.openArtifact(artifact, artifact.session_id);
  }
}

export function openLibraryFile(item: LibraryItem) {
  if (!item.file) return;
  openLibraryArtifact({ id: item.id, session_id: item.session, kind: storedFileArtifactKind(item.file), title: item.title,
    file_id: item.file.file_id, url: item.file.url, signed_url: item.file.signed_url, size_bytes: item.file.size_bytes,
    created_at: item.capturedAt, safe_path_label: item.file.safe_name, source_label: item.revisions?.[0]?.file.source_label,
    revisions: item.revisions, deliverable: true });
}
