import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { StackDeck, type StackDeckItem } from "./index";

const TASKS: StackDeckItem[] = [
  { id: "slides", label: "Turn it into slides" },
  { id: "summary", label: "Make a summary" },
  { id: "script", label: "Write the talk script" },
];

// #region recipe: Tasks running together
function TogetherDeck() {
  return (
    <StackDeck items={TASKS} renderCard={(item, { index, count, expanded }) => (
      <Stack gap="xs">
        <Stack align="row" gap="xs">
          <Typo.Body truncate>{item.label}</Typo.Body>
          {!expanded && index === 0 ? <Typo.Body tone="tertiary" wrap="nowrap" shrink={false}>+{count - 1} more</Typo.Body> : null}
        </Stack>
        <Typo.Caption tone="secondary" truncate>After Write the report</Typo.Caption>
      </Stack>
    )} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A 묶음 (stack) of cards that run together: one full-width row with hairline edges behind it, opened on a tap into a column of full-width cards in order.",
  whenToUse: [
    "Several items that share one place in an order (tasks that run together in one step)",
    "A compact row that still shows that it holds more, and whether they are running",
  ],
  whenNotToUse: [
    { when: "Items that each need their own row", use: "CardList" },
    { when: "Ordered steps people reorder and group by dragging", use: "StepSortableList" },
    { when: "Rows that open to show detail under them", use: "Collapsible" },
  ],
  recipes: [
    { name: "Tasks running together", description: "Items front first, each with `label` (the accessible names use it) and `running`. `renderCard` draws a row's content; the deck draws the Card. The collapsed front says how many it holds (`count`).", render: () => <TogetherDeck /> },
  ],
  doDont: [
    {
      do: { caption: "One deck per step; a tap opens it into a column, a tap on a card stacks it again.", render: () => <TogetherDeck /> },
      dont: { caption: "Cards piled with hand-made offsets: no open column, no running edges, no keyboard access.", render: () => (
        <Card padding="md"><Typo.Body>Turn it into slides +2 more</Typo.Body></Card>
      ) },
    },
  ],
  content: [
    "Card content is the item's own row (title, meta, one caption line); the collapsed front adds the count (ko: “외 N건”, en: “+N more”) outside the truncating title, so the count always shows.",
    "Pass localized `labels`: `expand(count, front)` names the collapsed deck (ko: “PPT로 정리 외 2건, 펼치기”), `fold(item)` each card of the open column (ko: “PPT로 정리, 접기”).",
  ],
  accessibility: [
    "No interactive element nests another: the Card is a plain container, covered by one transparent toggle button (aria-expanded) with the content above it. A tap anywhere on the card, or on an edge, reaches the toggle; the toggle's focus ring is drawn on the Card.",
    "Controls in the card (grip, ⋯) are the toggle's siblings: tab order is toggle, grip, ⋯. With `cardListeners`, they stop their own mouse-down and touch-start so they never start the card's drag.",
    "Enter or Space on the toggle opens the column and focus moves to the first card's toggle; each open card's toggle (aria-expanded=true) stacks the deck again (Escape too), and focus returns to the deck's toggle.",
    "The open column keeps the cards in reading and tab order; its gap is wider than the focus-ring room, so every ring shows whole.",
    "Edges are decorative (aria-hidden). Open: the cards slide down from behind the front card; stack: they slide back. Reduced motion: no travel, the cards fade in and out in place.",
  ],
  tokens: ["--worker-active", "--line", "--line-strong", "--border-hairline", "--radius-control", "--space-xs",
    "--focus-ring-room", "--motion-slow", "--motion-fast", "--motion-ease-emphasized", "--motion-ease-accelerate", "--motion-ease-standard"],
};
