import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { MarkdownContent } from "../MarkdownContent";
import { DocumentReader } from "./DocumentReader";

// #region recipe: Spec reader
function SpecReader() {
  return (
    <DocumentReader
      header={<Stack gap="sm"><Typo.Caption>Spec</Typo.Caption><Typo.H2>Model presets and OAuth</Typo.H2></Stack>}
      facts={[{ id: "status", label: "Status", value: "In review" }, { id: "path", label: "Source", value: "specs/model-presets.md" }]}
      hint="You are reading the source document; it is read-only.">
      <Typo.Body>Show the sign-in state with the chosen model and keep presets when a connection expires.</Typo.Body>
    </DocumentReader>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A read-only document view: header, fact list, hint, action, details and the document body.",
  whenToUse: ["Read a project document or spec in a dialog"],
  whenNotToUse: [
    { when: "Only rendered markdown", use: "MarkdownContent" },
    { when: "An artifact file preview", use: "ArtifactPreview" },
  ],
  recipes: [{ name: "Spec reader", description: "Facts before the body; the hint says it is read-only.", render: () => <SpecReader /> }],
  doDont: [
    {
      do: { caption: "Facts and a read-only hint frame the document.", render: () => <SpecReader /> },
      dont: { caption: "A bare document hides status and source.", render: () => <MarkdownContent><Typo.Body>Show the sign-in state…</Typo.Body></MarkdownContent> },
    },
  ],
  content: ["Facts use the product's document vocabulary (Status, Source, Updated)."],
  accessibility: ["Facts are a description list; the header holds the document heading."],
  tokens: ["--page-max-width-reading", "--text-secondary", "--space-lg"],
};
