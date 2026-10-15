import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { ListRow } from "../../blocks/ListRow";
import { Clock3 } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
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

// #region recipe: Toggle row aligned to the card content
function ToggleRow() {
  const [selected, setSelected] = useState(true);
  return (
    <Stack gap="xs">
      <Typo.Label tone="secondary">Top chats</Typo.Label>
      <Clickable bleed="inline" stretch selected={selected} onClick={() => setSelected(!selected)}>
        <ListRow title="Release checklist" meta="412K" />
      </Clickable>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Makes a row, tile or piece of text one keyboard-operable click target without a button's look.",
  whenToUse: [
    "Make a whole list row clickable",
    "Turn a title into a quiet text link that opens details",
    "A row that toggles a filter on and off (selected)",
  ],
  whenNotToUse: [
    { when: "A labelled action", use: "Button" },
    { when: "A sidebar navigation row", use: "NavRow" },
    { when: "A card that opens something", use: "Card" },
    { when: "Choosing one of a few labelled options", use: "SegmentedControl" },
  ],
  recipes: [
    { name: "Selectable list row", description: "stretch fills the row; aria-current marks the selected one.", render: () => <SelectableRow /> },
    {
      name: "Toggle row aligned to the card content",
      description: "bleed=\"inline\" lines the row's text up with the label above it; selected makes it a pressed toggle.",
      render: () => <ToggleRow />,
    },
  ],
  doDont: [
    {
      do: { caption: "Wrap presentational content (ListRow) and keep nested actions as buttons.", render: () => <SelectableRow /> },
      dont: {
        caption: "Wrapping a Button inside Clickable nests two interactive targets.",
        render: () => <Clickable onClick={() => undefined}><ListRow title="Nested target" meta="avoid" /></Clickable>,
      },
    },
  ],
  content: [
    "The content is the label; give an aria-label when it is only an icon or a long composite row.",
    "bleed=\"inline\" needs room beside the row: use it inside a padded surface (a settings card), not flush against a clipping edge.",
  ],
  accessibility: [
    "role=\"button\" with Enter and Space activation; disabled removes it from the tab order.",
    "selected sets aria-pressed, so a toggle row announces its state; leave it undefined on rows that do not toggle.",
    "Nested IconButtons must stop propagation so the row does not fire.",
  ],
  tokens: ["--selection", "--selection-strong", "--radius-control", "--focus-ring", "--interactive-disabled-fg", "--motion-fast"],
};
