import type { ShowcaseGuidance } from "../../showcase";
import { FileText, Save } from "../../components/Icons";
import { Card } from "../../components/Card";
import { Typo } from "../../components/Typo";
import { DocumentTile } from "./DocumentTile";

// #region recipe: Inspector artifact tile
function ArtifactTile() {
  return (
    <DocumentTile icon={<FileText size="md" />} title="release-notes.md" description="document / 4.2 KB" meta="2d ago"
      clickTarget="tile" ariaLabel="Open: release-notes.md" onOpen={() => undefined}
      actions={[{ id: "save", label: "Save", icon: <Save size="sm" />, onClick: () => undefined }]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A document or artifact tile: badge, title, meta and either a whole-tile open or an explicit Open action.",
  whenToUse: ["Artifacts in the inspector", "Plans and specs on the project dashboard"],
  whenNotToUse: [
    { when: "Artifacts under an answer", use: "ArtifactList" },
    { when: "A resource in a grid", use: "CardList" },
  ],
  recipes: [{ name: "Inspector artifact tile", description: "clickTarget=\"tile\" opens on click; icon actions stay separate.", render: () => <ArtifactTile /> }],
  doDont: [
    {
      do: { caption: "One clear open target plus labelled actions.", render: () => <ArtifactTile /> },
      dont: { caption: "A card with an ambiguous click target.", render: () => <Card interactive onClick={() => undefined} aria-label="release-notes.md"><Typo.Body>release-notes.md</Typo.Body></Card> },
    },
  ],
  content: ["Badges are one word (Plan, Spec); meta is a status or a path."],
  accessibility: ["ariaLabel says the action (Open: title); nested actions stop propagation."],
  tokens: ["--surface-raised", "--radius-panel", "--line", "--selection"],
};
