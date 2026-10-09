import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { Grid } from "../../components/Grid";
import { Trash2 } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { OverflowActionMenu } from "../OverflowActionMenu";
import { LibraryCard } from "./LibraryCard";

// #region recipe: Library grid
function LibraryGrid() {
  const menu = <OverflowActionMenu label="More" items={[{ icon: <Trash2 size="sm" />, label: "Delete", onSelect: () => undefined, variant: "destructive" }]} />;
  return (
    <Grid columns="3" gap="md">
      <LibraryCard media={{ kind: "quote", text: "“Adjust the lumbar height before the backrest angle.”" }} title="Lumbar height comes first"
        meta="desk.example.kr · Today" tag="Element" menu={menu} onOpen={() => undefined} />
      <LibraryCard media={{ kind: "document" }} title="Q3 report" meta="Files · 10/2" tag="Document" menu={menu} onOpen={() => undefined} />
      <LibraryCard media={{ kind: "document" }} title="Weekly summary" meta="Butler output · 10/5" tag="View" menu={menu} onOpen={() => undefined} />
    </Grid>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One library (서랍) item on a Card with a media slot: an image, quote or document preview, a kind tag, title, source and a ⋯ menu.",
  whenToUse: ["The library page and the new-tab page's recent scraps", "Any grid of saved page pieces (elements, views, outputs)"],
  whenNotToUse: [
    { when: "A file or output in the inspector", use: "ArtifactList" },
    { when: "A document with status and dates", use: "DocumentTile" },
  ],
  recipes: [{ name: "Library grid", description: "3 or 4 columns (Grid); the menu stays its own button.", render: () => <LibraryGrid /> }],
  doDont: [
    {
      do: { caption: "A text scrap previews its words.", render: () => <LibraryGrid /> },
      dont: { caption: "Do not nest the menu inside a clickable card.", render: () => <Card interactive onClick={() => undefined}><Typo.Text>Scrap ⋯</Typo.Text></Card> },
    },
  ],
  content: ["Kind tags are one word: Element / 요소, View / 화면, Document / 문서. Meta is “source · date”."],
  accessibility: ["The media and title are one button named by the title; the ⋯ menu is a separate button.", "Images are decorative (the title names the item)."],
  tokens: ["--radius-control", "--muted", "--line-height-body", "--text-tertiary"],
};
