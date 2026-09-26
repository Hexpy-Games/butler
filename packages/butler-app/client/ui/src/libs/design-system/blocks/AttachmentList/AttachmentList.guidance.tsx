import type { ShowcaseGuidance } from "../../showcase";
import { FileText } from "../../components/Icons";
import { ListRow } from "../ListRow";
import { AttachmentList } from "./AttachmentList";

// #region recipe: Removable composer attachments
function ComposerAttachments() {
  return (
    <AttachmentList variant="chips" onRemove={() => undefined} items={[
      { id: "notes", name: "project-notes.md", meta: "4 KB", icon: <FileText size="sm" /> },
      { id: "export", name: "large-export.json", meta: "2 MB" },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Files attached to a message: a list with sizes and links, or removable chips in the composer.",
  whenToUse: ["Files the user attached (composer chips) or sent (message list)"],
  whenNotToUse: [
    { when: "Files Butler produced", use: "ArtifactList" },
    { when: "Project documents", use: "DocumentTile" },
  ],
  recipes: [{ name: "Removable composer attachments", description: "variant=\"chips\" wraps and truncates long names; onRemove adds remove buttons.", render: () => <ComposerAttachments /> }],
  doDont: [
    {
      do: { caption: "Chips with size and a remove button.", render: () => <ComposerAttachments /> },
      dont: { caption: "List rows for pending attachments take too much composer space.", render: () => <ListRow icon={<FileText size="md" />} title="project-notes.md" meta="4 KB" /> },
    },
  ],
  content: ["windowDrag=\"no-drag\" keeps chips removable inside a drag region.", "Show the file name as uploaded and a human size (4 KB)."],
  accessibility: ["Remove buttons are labelled with the file name; image thumbnails need alt text."],
  tokens: ["--radius-pill", "--line", "--icon-size-sm"],
};
