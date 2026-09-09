import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Button,
  ScrollArea,
} from "@/butler-ds";
import { projectDocumentDialogLayout } from "@/app/projectDocuments.ts";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import { ProjectDocumentMarkdownContent } from "./ProjectDocumentMarkdownContent.tsx";
import { ArtifactViewer } from "@/components/artifacts/ArtifactViewer.tsx";

const DIALOG_STYLE = {
  width: "min(880px, calc(100vw - 32px))",
};

export function ProjectDocumentDialog({
  document,
  onClose,
  onStartChatWithDocument,
  onLoadMore,
}: {
  document: ProjectDashboardDocument | null;
  onClose: () => void;
  onStartChatWithDocument?: (document: ProjectDashboardDocument) => void;
  onLoadMore?: () => void;
}) {
  useAppLocale();
  return (
    <Dialog
      open={Boolean(document)}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent data-project-ledger-modal="true" style={DIALOG_STYLE}>
        <DialogHeader>
          <DialogTitle>{document?.title}</DialogTitle>
          <DialogDescription>{document?.artifact ? appCopy.projectSignpost.results : document?.safe_path_label}</DialogDescription>
        </DialogHeader>
        <div style={projectDocumentDialogLayout.body}>
          <ScrollArea
            style={projectDocumentDialogLayout.scroller}
            contentStyle={projectDocumentDialogLayout.markdownPadding}
          >
            {document?.artifact ? <ArtifactViewer artifact={document.artifact} onBack={onClose} embedded /> : document ? (
              <ProjectDocumentMarkdownContent markdown={document.markdown} />
            ) : null}
            {document?.truncated && <Button variant="outline" onClick={onLoadMore} disabled={!onLoadMore}>
              {appCopy.projectSignpost.loadMore}
            </Button>}
          </ScrollArea>
          {document && onStartChatWithDocument ? (
            <Button
              style={projectDocumentDialogLayout.startAction}
              type="button"
              variant="default"
              onClick={() => onStartChatWithDocument(document)}
            >
              {appCopy.projectSignpost.addToComposer}</Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
