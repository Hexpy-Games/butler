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

const DIALOG_STYLE = {
  width: "min(880px, calc(100vw - 32px))",
};

export function ProjectDocumentDialog({
  document,
  onClose,
  onStartChatWithDocument,
}: {
  document: ProjectDashboardDocument | null;
  onClose: () => void;
  onStartChatWithDocument?: (document: ProjectDashboardDocument) => void;
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
          <DialogDescription>{document?.safe_path_label}</DialogDescription>
        </DialogHeader>
        <div style={projectDocumentDialogLayout.body}>
          <ScrollArea
            style={projectDocumentDialogLayout.scroller}
            contentStyle={projectDocumentDialogLayout.markdownPadding}
          >
            {document ? (
              <ProjectDocumentMarkdownContent markdown={document.markdown} />
            ) : null}
          </ScrollArea>
          {document && onStartChatWithDocument ? (
            <Button
              style={projectDocumentDialogLayout.startAction}
              type="button"
              variant="default"
              onClick={() => onStartChatWithDocument(document)}
            >
              {appCopy.interfaceDetails.documentConversation}</Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
