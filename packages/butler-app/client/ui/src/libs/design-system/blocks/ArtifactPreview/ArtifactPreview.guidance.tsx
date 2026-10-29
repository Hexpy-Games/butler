import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../../components/Box";
import { PageContainer } from "../../components/PageContainer";
import { Typo } from "../../components/Typo";
import { MarkdownContent } from "../MarkdownContent";
import { ScrollArea } from "../ScrollArea";
import { ArtifactPreview, ArtifactPreviewPre } from "./index";

// #region recipe: Text artifact preview
function TextPreview() {
  return (
    <ArtifactPreview>
      <ArtifactPreviewPre>{"# Release notes\n\n- Token pages generated from tokens.css"}</ArtifactPreviewPre>
    </ArtifactPreview>
  );
}
// #endregion

// #region recipe: Reading page in a docked viewer
function ReadingPage() {
  // The viewer's ScrollArea scrolls the page; PageContainer's gutter plus the Box padding give 48px insets.
  return (
    <ScrollArea fill>
      <PageContainer width="narrow" gutter="2xl">
        <Box paddingY="2xl">
          <Box padding="2xl">
            <ArtifactPreview surface="page">
              <ArtifactPreviewPre>{"export const ready = true;"}</ArtifactPreviewPre>
            </ArtifactPreview>
          </Box>
        </Box>
      </PageContainer>
    </ScrollArea>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The artifact viewer body: exactly one of text, image or frame (PDF/HTML), or a loading/failed caption.",
  whenToUse: [
    "Preview an artifact in the artifact viewer or a document dialog",
    "Show a file as a reading page in a docked viewer (surface=\"page\")",
  ],
  whenNotToUse: [
    { when: "Rendered markdown documents", use: "MarkdownContent" },
    { when: "Reading a spec with facts", use: "DocumentReader" },
  ],
  recipes: [
    { name: "Text artifact preview", description: "Choose Pre, Image or Frame by the artifact mode.", render: () => <TextPreview /> },
    {
      name: "Reading page in a docked viewer",
      description: "surface=\"page\" draws no box and no inner scroll: the host's ScrollArea scrolls the page, and the host gives the reading width and insets.",
      render: () => <ReadingPage />,
    },
  ],
  doDont: [
    {
      do: { caption: "Raw text keeps its whitespace in a scrollable pre.", render: () => <TextPreview /> },
      dont: { caption: "Rendering unknown text as markdown can reflow or hide content.", render: () => <MarkdownContent><Typo.Body># Release notes</Typo.Body></MarkdownContent> },
    },
  ],
  content: [
    "Loading and failure captions name the artifact state, not technical errors.",
    "A frame whose content has its own size (a scrap's clipped part) passes intrinsicSize; larger content scrolls inside the preview.",
    "surface=\"card\" (default) is a bordered box with its own scroll inside a panel or dialog. surface=\"page\" is for a host that is itself the reading surface, such as a file viewer in AdaptiveShellSplit's right slot; images there sit frameless with their own corner radius.",
  ],
  accessibility: ["Images need alt text (the title); frames need a title."],
  tokens: ["--surface", "--radius-panel", "--typo-code-size"],
};
