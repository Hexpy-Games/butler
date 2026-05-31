import type { AnchorHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Button,
  MarkdownContent,
  ScrollArea,
  Stack,
  SurfacePanel,
  Typo,
} from "@/butler-ds";
import {
  projectDocumentDialogLayout,
  projectDocumentMarkdownView,
} from "@/app/projectDocuments.ts";
import type { ProjectDashboardDocument } from "@/app/types.ts";

const MARKDOWN_COMPONENTS = {
  a({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
    if (!href) return <span>{children}</span>;
    return (
      <a {...props} href={href} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  },
};

const DIALOG_STYLE = {
  minWidth: "min(680px, calc(100vw - 32px))",
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
  const documentView = document
    ? projectDocumentMarkdownView(document.markdown)
    : { body: "", frontmatter: [] };

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
            <Stack gap="md">
              {documentView.frontmatter.length > 0 && (
                <SurfacePanel
                  data-test-class="project-document-frontmatter"
                  elevation="none"
                  style={projectDocumentDialogLayout.metadataPanel}
                >
                  <Stack gap="xs">
                    {documentView.frontmatter.map((entry) => (
                      <div
                        key={entry.key}
                        style={projectDocumentDialogLayout.metadataRow}
                      >
                        <Typo.Caption
                          style={projectDocumentDialogLayout.metadataLabel}
                        >
                          {entry.label}
                        </Typo.Caption>
                        <Typo.Caption
                          style={projectDocumentDialogLayout.metadataValue}
                        >
                          {entry.value}
                        </Typo.Caption>
                      </div>
                    ))}
                  </Stack>
                </SurfacePanel>
              )}
              <MarkdownContent>
                <ReactMarkdown
                  components={MARKDOWN_COMPONENTS}
                  remarkPlugins={[remarkGfm]}
                >
                  {documentView.body}
                </ReactMarkdown>
              </MarkdownContent>
            </Stack>
          </ScrollArea>
          {document && onStartChatWithDocument ? (
            <Button
              style={projectDocumentDialogLayout.startAction}
              type="button"
              variant="default"
              onClick={() => onStartChatWithDocument(document)}
            >
              이 문서로 대화 시작하기
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
