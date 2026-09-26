import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Card } from "./Card";

// #region recipe: Interactive work card
function WorkCard() {
  return (
    <Card interactive aria-label="Ship the token pages" onClick={() => undefined}>
      <Stack gap="md">
        <Typo.Body lineClamp={2} wrap="anywhere">Ship the token pages</Typo.Body>
        <Typo.Caption>Tasks 3/5 · Plan 2/4</Typo.Caption>
      </Stack>
    </Card>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A raised container for one item in a grid of items, optionally interactive and selectable.",
  whenToUse: ["An item in a dashboard grid", "A suggestion or briefing entry with its own action"],
  whenNotToUse: [
    { when: "Only padding or a background", use: "Box" },
    { when: "A document or artifact tile with actions", use: "DocumentTile" },
    { when: "A row in a list", use: "ListRow" },
  ],
  recipes: [{ name: "Interactive work card", description: "interactive + onClick makes the card a keyboard-operable button.", render: () => <WorkCard /> }],
  doDont: [
    {
      do: { caption: "Cards group items that belong together in a grid.", render: () => <WorkCard /> },
      dont: { caption: "Cards nested in cards stack shadows and borders.", render: () => <Card><Card><Typo.Body>Nested card</Typo.Body></Card></Card> },
    },
  ],
  content: ["Title in two lines at most (lineClamp=2); secondary facts go in a caption."],
  accessibility: ["Interactive cards need aria-label; nested buttons stop propagation."],
  tokens: ["--surface-raised", "--radius-panel", "--shadow-card", "--selection", "--focus-ring"],
};
