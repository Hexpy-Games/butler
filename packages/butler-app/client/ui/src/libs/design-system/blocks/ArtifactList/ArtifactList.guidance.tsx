import type { ShowcaseGuidance } from "../../showcase";
import { FileText, Save } from "../../components/Icons";
import { AttachmentList } from "../AttachmentList";
import { ArtifactList } from "./ArtifactList";

// #region recipe: Files under an answer
function AnswerArtifacts() {
  return (
    <ArtifactList aria-label="Artifacts" items={[
      { id: "notes", title: "release-notes.md", description: "document / 4.2 KB", icon: <FileText size="lg" />, onOpen: () => undefined,
        actions: [{ id: "save", label: "Save", ariaLabel: "Save: release-notes.md", href: "#", download: "release-notes.md", icon: <Save size="sm" /> }] },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Files Butler produced in an answer: open the artifact, save it, or run another action.",
  whenToUse: ["Artifacts attached to an assistant message"],
  whenNotToUse: [
    { when: "Files the user attached", use: "AttachmentList" },
    { when: "Artifacts in the inspector", use: "DocumentTile" },
  ],
  recipes: [{ name: "Files under an answer", description: "onOpen opens the viewer; actions are labelled icon buttons or downloads.", render: () => <AnswerArtifacts /> }],
  doDont: [
    {
      do: { caption: "Artifacts show type, size and a save action.", render: () => <AnswerArtifacts /> },
      dont: { caption: "Attachment chips for generated files blur who made them.", render: () => <AttachmentList items={[{ id: "a", name: "release-notes.md", meta: "4 KB" }]} /> },
    },
  ],
  content: ["Descriptions are type / size (document / 4.2 KB).", "The list uses --radius-popover (12px), like the message bubbles it sits under.",
    "Layout follows the card's width, not the window: actions stay on the name's row, right-aligned, while the name keeps about 120px; on a narrower card they wrap to their own row at the right edge. Cards 400px or narrower use 32px icons."],
  accessibility: ["aria-label names the list; each action names its file."],
  tokens: ["--surface-raised", "--radius-popover", "--icon-size-lg"],
};
