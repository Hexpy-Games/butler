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

// #region recipe: Running task card
function RunningTaskCard() {
  return (
    <Card interactive padding="sm" activity="running" aria-label="Research Notion, running" onClick={() => undefined}>
      <Stack gap="xs">
        <Typo.Body lineClamp={2}>Research Notion</Typo.Body>
        <Typo.Caption tone="tertiary">Worker 3 · 9m 01s</Typo.Caption>
      </Stack>
    </Card>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A raised container for one item in a grid of items, optionally interactive and selectable.",
  whenToUse: [
    "An item in a dashboard grid",
    "A suggestion or briefing entry with its own action",
    "A running task in a task graph (activity=\"running\")",
  ],
  whenNotToUse: [
    { when: "Only padding or a background", use: "Box" },
    { when: "A document or artifact tile with actions", use: "DocumentTile" },
    { when: "A row in a list", use: "ListRow" },
  ],
  recipes: [
    { name: "Interactive work card", description: "interactive + onClick makes the card a keyboard-operable button.", render: () => <WorkCard /> },
    { name: "Running task card", description: "activity=\"running\" adds the worker-active border and a pulse ring that rests under reduced motion.", render: () => <RunningTaskCard /> },
  ],
  doDont: [
    {
      do: { caption: "Cards group items that belong together in a grid.", render: () => <WorkCard /> },
      dont: { caption: "Cards nested in cards stack shadows and borders.", render: () => <Card><Card><Typo.Body>Nested card</Typo.Body></Card></Card> },
    },
    {
      do: { caption: "Mark only live work as running, next to a spinner in the card.", render: () => <RunningTaskCard /> },
      dont: { caption: "Running is not a highlight for selection or errors; use selected or a Notice.", render: () => <Card activity="running"><Typo.Body>Selected item</Typo.Body></Card> },
    },
  ],
  content: ["Title in two lines at most (lineClamp=2); secondary facts go in a caption."],
  accessibility: [
    "Interactive cards need aria-label; nested buttons stop propagation.",
    "activity=\"running\" is visual only: say the state in text (a status Tag) and in aria-label.",
  ],
  tokens: ["--surface-raised", "--radius-panel", "--shadow-card", "--selection", "--focus-ring", "--worker-active", "--pulse-duration", "--motion-loop-count"],
};
