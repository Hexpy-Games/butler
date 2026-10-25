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

// #region recipe: Inline-editable text with room above and below
function EditableText() {
  return (
    <Clickable bleed="both" stretch aria-label="Edit description" onClick={() => undefined}>
      <Typo.Body>Collect the changes and review the release notes.</Typo.Body>
    </Clickable>
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
    {
      name: "Inline-editable text with room above and below",
      description: "bleed=\"both\" gives the hover fill room on every side; the text and the rows around it do not move.",
      render: () => <EditableText />,
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
    "bleed=\"block\" (or \"both\") reaches --space-xs above and below: keep at least that gap to the neighbouring rows, plus --focus-ring-room for the ring.",
    "Row fills already fade on the hover token and press lands at once; a className needs no background transition of its own.",
  ],
  accessibility: [
    "role=\"button\" with Enter and Space activation; disabled removes it from the tab order.",
    "selected sets aria-pressed, so a toggle row announces its state; leave it undefined on rows that do not toggle.",
    "Nested IconButtons must stop propagation so the row does not fire.",
    "With prefers-reduced-motion the fill fade is dropped: fills change at once.",
  ],
  tokens: ["--selection", "--selection-strong", "--radius-control", "--space-xs", "--focus-ring", "--interactive-disabled-fg", "--motion-fast", "--motion-instant", "--motion-ease-standard"],
};
