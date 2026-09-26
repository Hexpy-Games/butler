import type { ShowcaseGuidance } from "../../showcase";
import { ListRow } from "../../blocks/ListRow";
import { Clock3 } from "../Icons";
import { Clickable } from "./Clickable";

// #region recipe: Selectable list row
function SelectableRow() {
  return (
    <Clickable aria-current="page" onClick={() => undefined} stretch>
      <ListRow icon={<Clock3 size="md" />} title="Nightly release notes" meta="Every day 07:00" />
    </Clickable>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Makes a row, tile or piece of text one keyboard-operable click target without a button's look.",
  whenToUse: ["Make a whole list row clickable", "Turn a title into a quiet text link that opens details"],
  whenNotToUse: [
    { when: "A labelled action", use: "Button" },
    { when: "A sidebar navigation row", use: "NavRow" },
    { when: "A card that opens something", use: "Card" },
  ],
  recipes: [{ name: "Selectable list row", description: "stretch fills the row; aria-current marks the selected one.", render: () => <SelectableRow /> }],
  doDont: [
    {
      do: { caption: "Wrap presentational content (ListRow) and keep nested actions as buttons.", render: () => <SelectableRow /> },
      dont: {
        caption: "Wrapping a Button inside Clickable nests two interactive targets.",
        render: () => <Clickable onClick={() => undefined}><ListRow title="Nested target" meta="avoid" /></Clickable>,
      },
    },
  ],
  content: ["The content is the label; give an aria-label when it is only an icon or a long composite row."],
  accessibility: [
    "role=\"button\" with Enter and Space activation; disabled removes it from the tab order.",
    "Nested IconButtons must stop propagation so the row does not fire.",
  ],
  tokens: ["--selection", "--radius-control", "--focus-ring", "--interactive-disabled-fg"],
};
