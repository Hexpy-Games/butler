import type { ShowcaseGuidance } from "../../showcase";
import { Typo } from "../../components/Typo";
import { MarkdownContent } from "../MarkdownContent";
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

export const guidance: ShowcaseGuidance = {
  purpose: "The artifact viewer body: exactly one of text, image or frame (PDF/HTML), or a loading/failed caption.",
  whenToUse: ["Preview an artifact in the artifact viewer or a document dialog"],
  whenNotToUse: [
    { when: "Rendered markdown documents", use: "MarkdownContent" },
    { when: "Reading a spec with facts", use: "DocumentReader" },
  ],
  recipes: [{ name: "Text artifact preview", description: "Choose Pre, Image or Frame by the artifact mode.", render: () => <TextPreview /> }],
  doDont: [
    {
      do: { caption: "Raw text keeps its whitespace in a scrollable pre.", render: () => <TextPreview /> },
      dont: { caption: "Rendering unknown text as markdown can reflow or hide content.", render: () => <MarkdownContent><Typo.Body># Release notes</Typo.Body></MarkdownContent> },
    },
  ],
  content: ["Loading and failure captions name the artifact state, not technical errors."],
  accessibility: ["Images need alt text (the title); frames need a title."],
  tokens: ["--surface", "--radius-panel", "--typo-code-size"],
};
