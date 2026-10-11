import type { ShowcaseGuidance } from "../../showcase";
import { Grid } from "../../components/Grid";
import { NavRow } from "../NavRow";
import { GroupTile, GroupTileMore } from "./GroupTile";

// #region recipe: Group row on the Library main screen
function GroupRow() {
  return (
    <Grid columns="4" gap="md">
      <GroupTile name="Travel" meta="5 scraps · Oct 10" emptyLabel="Empty" previews={[{ kind: "quote", text: "Day 1 · Airport → Aewol" }, { kind: "document" }]} onOpen={() => undefined} />
      <GroupTile name="Recipes" meta="2 scraps · Oct 6" emptyLabel="Empty" previews={[{ kind: "document" }, { kind: "quote", text: "60 g basil" }]} onOpen={() => undefined} />
      <GroupTile name="Gift ideas" meta="0 scraps" emptyLabel="Empty" previews={[]} onOpen={() => undefined} />
      <GroupTileMore count={2} label="2 more groups" meta="View all" onOpen={() => undefined} />
    </Grid>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A group (a scrap group or a bookmark folder) as a folder card: a mosaic of its newest items in a LibraryCard-sized slot, the name, count and date, and a ⋯ menu.",
  whenToUse: ["Groups at the top of a kind section on the Library main screen", "Any grid where a folder should show what it holds and accept drops"],
  whenNotToUse: [
    { when: "One saved item", use: "LibraryCard" },
    { when: "A folder in the sidebar tree", use: "CollapsibleNavGroup" },
  ],
  recipes: [{ name: "Group row on the Library main screen", description: "One row of tiles in the same Grid as the cards; the last cell is GroupTileMore when groups overflow.", render: () => <GroupRow /> }],
  doDont: [
    {
      do: { caption: "Tiles share the cards' grid and slot size, so rows line up.", render: () => <GroupRow /> },
      dont: { caption: "Do not list groups as navigation rows inside the page.", render: () => <NavRow label="Travel" onClick={() => undefined} /> },
    },
  ],
  content: [
    "Name: the group's own name, one line. Meta: “5 scraps · Oct 10” (count and latest date). Empty: “Empty” / “비어 있음”.",
    "Overflow tile: “+N” with “N more groups” and “View all”. Drop hint: “Add to “Travel”” / “‘여행’에 넣기”.",
  ],
  accessibility: ["The tile is one button named like “Travel group, 5 scraps”; the ⋯ menu is its own button.", "The mosaic is decorative (aria-hidden)."],
  tokens: ["--muted", "--radius-control", "--accent", "--surface-raised", "--text-tertiary"],
};
