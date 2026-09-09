import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Button,
  DocumentReader, DisclosureRow, KeyValueRow, Stack, Typo, MessageSquarePlus,
} from "@/butler-ds";
import { projectDocumentReaderView } from "@/app/projectDocumentReader.ts";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import { ProjectDocumentMarkdownContent } from "./ProjectDocumentMarkdownContent.tsx";
import { ArtifactViewer } from "@/components/artifacts/ArtifactViewer.tsx";

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
  const [expandedDocument, setExpandedDocument] = useState<string | null>(null);
  const view = document ? projectDocumentReaderView(document) : null;
  const copy = appCopy.projectDocumentMetadata;
  const close = () => { setExpandedDocument(null); onClose(); };
  return (
    <Dialog
      open={Boolean(document)}
      onOpenChange={(open) => !open && close()}
    >
      <DialogContent style={{ width: "min(880px, calc(100vw - 32px))", overflow: "hidden" }}>
        {document && view && <DocumentReader
          header={<DialogHeader>
            <DialogDescription>{view.facts[0]?.value}</DialogDescription>
            <DialogTitle asChild><Typo.H2>{document.title}</Typo.H2></DialogTitle>
          </DialogHeader>}
          facts={view.facts}
          hint={copy.readOnly}
          action={onStartChatWithDocument && <Button type="button" variant="outline"
            onClick={() => onStartChatWithDocument(document)}>
            <MessageSquarePlus />{copy.referenceAction}
          </Button>}
          details={<DisclosureRow title={copy.sourceDetails} surface="plain"
            open={expandedDocument === document.id}
            onToggle={() => setExpandedDocument(expandedDocument === document.id ? null : document.id)}>
            <Stack gap="xs">{view.details.map((entry) =>
              <KeyValueRow key={entry.key} label={entry.label} value={entry.value} valueTextSize="caption" />,
            )}</Stack>
          </DisclosureRow>}
        >
          {document.artifact ? <ArtifactViewer artifact={document.artifact} onBack={close} embedded />
            : <ProjectDocumentMarkdownContent markdown={view.body} />}
          {document.truncated && <Button variant="outline" onClick={onLoadMore} disabled={!onLoadMore}>
            {appCopy.projectSignpost.loadMore}
          </Button>}
        </DocumentReader>}
      </DialogContent>
    </Dialog>
  );
}
