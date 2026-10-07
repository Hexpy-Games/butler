import { faviconSrc } from "@/app/favicons.ts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Grid, MarkdownContent, MarkdownLink, Stack, SurfacePanel, Typo } from "@/butler-ds";
import { projectDocumentMarkdownView } from "@/app/projectDocuments.ts";

const MARKDOWN_COMPONENTS = { a: MarkdownLink };

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
        >
          <Stack gap="xs">
            {view.frontmatter.map((entry) => (
              <Grid key={entry.key} columns="label-value" gap="sm">
                <Typo.Caption tone="tertiary">
                  {entry.label}
                </Typo.Caption>
                <Typo.Caption tone="secondary" wrap="anywhere">
                  {entry.value}
                </Typo.Caption>
              </Grid>
            ))}
          </Stack>
        </SurfacePanel>
      ) : null}
      <MarkdownContent faviconSrc={faviconSrc}>
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
