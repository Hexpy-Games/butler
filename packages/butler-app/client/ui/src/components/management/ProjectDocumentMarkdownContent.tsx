import type { AnchorHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownContent, Stack, SurfacePanel, Typo } from "@/butler-ds";
import {
  projectDocumentDialogLayout,
  projectDocumentMarkdownView,
} from "@/app/projectDocuments.ts";

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

export function ProjectDocumentMarkdownContent({
  markdown,
}: {
  markdown: string;
}) {
  const view = projectDocumentMarkdownView(markdown);
  return (
    <Stack gap="md">
      {view.frontmatter.length > 0 ? (
        <SurfacePanel
          data-test-class="project-document-frontmatter"
          elevation="none"
          style={projectDocumentDialogLayout.metadataPanel}
        >
          <Stack gap="xs">
            {view.frontmatter.map((entry) => (
              <div
                key={entry.key}
                style={projectDocumentDialogLayout.metadataRow}
              >
                <Typo.Caption style={projectDocumentDialogLayout.metadataLabel}>
                  {entry.label}
                </Typo.Caption>
                <Typo.Caption style={projectDocumentDialogLayout.metadataValue}>
                  {entry.value}
                </Typo.Caption>
              </div>
            ))}
          </Stack>
        </SurfacePanel>
      ) : null}
      <MarkdownContent>
        <ReactMarkdown
          components={MARKDOWN_COMPONENTS}
          remarkPlugins={[remarkGfm]}
        >
          {view.body}
        </ReactMarkdown>
      </MarkdownContent>
    </Stack>
  );
}
