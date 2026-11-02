import { appCopy } from "@/app/copy";
import { LIBRARY_VIEWER, useFileViewerState, useSessionFiles } from "@/app/fileViewerState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/butler-ds";
import { DocumentPage } from "../documents/DocumentPage";
import { FileViewerPane } from "../file-viewer/FileViewerPane";
import type { DocumentPageRenderer } from "../file-viewer/FileViewerDocument";

/** A file over the drawer, with its own tabs; the underlying list, filters and scroll stay in place. */
export function LibraryFileViewer() {
  const files = useSessionFiles(LIBRARY_VIEWER);
  return <Dialog open={files.shown && files.entries.length > 0}
    onOpenChange={(open) => useFileViewerState.getState().setShown(LIBRARY_VIEWER, open)}>
    <DialogContent size="full" height="full" layout="scroll-body" showCloseButton={false} aria-describedby={undefined} data-test-class="library-file-viewer">
      <DialogHeader><DialogTitle>{appCopy.fileViewer.title}</DialogTitle></DialogHeader>
      <FileViewerPane sessionId={LIBRARY_VIEWER} documentPage={renderDocument} />
    </DialogContent>
  </Dialog>;
}

const renderDocument: DocumentPageRenderer = (id, controls) => <DocumentPage id={id} {...controls} />;
