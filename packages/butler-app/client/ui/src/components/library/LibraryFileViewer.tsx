import { LIBRARY_VIEWER, useFileViewerState } from "@/app/fileViewerState";
import { DocumentPage } from "../documents/DocumentPage";
import { FileViewerPane } from "../file-viewer/FileViewerPane";
import type { DocumentPageRenderer } from "../file-viewer/FileViewerDocument";

/** Shares the drawer's content region; its mounted list retains filters and scroll while hidden. */
export function LibraryFileViewer() {
  return <FileViewerPane sessionId={LIBRARY_VIEWER} documentPage={renderDocument}
    onClose={() => useFileViewerState.getState().setShown(LIBRARY_VIEWER, false)} />;
}

const renderDocument: DocumentPageRenderer = (id, controls) => <DocumentPage id={id} {...controls} />;
