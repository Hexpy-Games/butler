import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { SortableCardList } from "../SortableCardList";
import { StepListDemo } from "./StepSortableList.demo";
import { applyStepSortableEdit, StepSortableList, type StepSortableChain } from "./index";

const CHAINS: StepSortableChain[] = [
  { id: "report", label: "Report", steps: [[{ id: "write", label: "Write the report", running: true }], [{ id: "slides", label: "Turn it into slides" }, { id: "summary", label: "Make a summary" }], [{ id: "script", label: "Write the talk script" }]] },
];

// #region recipe: Steps and stacks
function TaskSteps() {
  const [chains, setChains] = useState(CHAINS);
  return (
    <StepSortableList chains={chains}
      renderItem={(task, { stepIndex, count, expanded }) => ({
        marker: stepIndex === 0 ? undefined : stepIndex,
        title: !expanded && count > 1 ? `${task.label} +${count - 1}` : task.label,
        meta: task.running ? "Running" : "Waiting",
        caption: stepIndex === 0 ? "Drafting chapter 3" : "After the previous step",
      })}
      onEdit={(edit) => setChains((current) => applyStepSortableEdit(current, edit))} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Ordered chains of steps, each step one item or a flat 묶음 (StackDeck), reordered and grouped by drag or keyboard; it reports semantic edits.",
  whenToUse: [
    "Tasks that run in steps after one another, where some steps run several tasks together (the work tab)",
    "People change the order, merge tasks into a step, split them out or move them to another chain",
  ],
  whenNotToUse: [
    { when: "One flat list people reorder", use: "SortableCardList" },
    { when: "Items moving between status lanes", use: "KanbanBoard" },
    { when: "Rows of the sidebar tree", use: "NavDropTarget" },
  ],
  recipes: [
    {
      name: "Steps and stacks",
      description: "Controlled `chains`; `renderItem` maps an item to row slots (marker, title, meta, caption, trailing ⋯). `onEdit` gets { type: move_to_new_step | split_stack | join_stack | move_between, itemIds, from, to (step indexes before the edit), placement }; applyStepSortableEdit applies it optimistically.",
      render: () => <TaskSteps />,
    },
  ],
  doDont: [
    {
      do: { caption: "One list per 과제: heads first, follow-ups indented, 묶음 as decks; persist each edit with its revision.", render: (context) => <StepListDemo context={context} shape={[["a!", "b+c", "d"]]} /> },
      dont: { caption: "A flat sortable list cannot say which tasks run together.", render: () => (
        <SortableCardList items={[{ id: "a", title: "Turn it into slides" }, { id: "b", title: "Make a summary" }]} onReorder={() => undefined} />
      ) },
    },
  ],
  content: [
    "Each caption says the row's own state, never the meta's status word again: progress while running, the result when done, why a held row waits.",
    "Row slots follow the work-tab row: number (follow-ups) or status glyph (heads), title, `more` (a collapsed 묶음's count, ko: 외 N건; it never truncates), short meta (Running · 12 min, Waiting, Paused), one caption line, ⋯ (Start now, Unstack, Delete). Running rows have no ⋯; their room stays, except on a row narrower than 28rem, where the title takes the empty ⋯ room (the grip slot stays, so numbers line up). The title gets its line first: the meta, then the count, wrap before the title truncates. An open 묶음's cards are the same rows in one column: one indent, the step number on the first card only.",
    "The lifted copy's context says what a drop does now (`outcome`); say it in its caption (ko: 함께 진행 / 새 단계로).",
    "Pass localized `labels` (StepSortableLabels) and `deckLabels`; English is the default.",
  ],
  accessibility: [
    "Grips are buttons named by `labels.grip`; Space or Enter lifts, Up/Down visit every gap (new step) and step (join), Space or Enter drops, Escape or Tab cancels. Focus follows the item after a drop.",
    "No control nests another: a single step's card is plain, and a 묶음's cards carry StackDeck's toggle beside the grip and ⋯ (tab order toggle, grip, ⋯; the toggle's ring is drawn on the card).",
    "Pick-up, every keyboard step, the drop and a cancel are announced in a polite live region; dnd-kit's own id announcements are silenced.",
    "Pointer: a card or its grip drags after 4 px; touch after a 180 ms press. A collapsed 묶음 drags as one step; a card of an open 묶음 drags out on its own (split).",
    "Running and pinned items have no grip; a step holding one never drags as a whole, takes no joins, and nothing goes before a pinned head.",
    "Drags auto-scroll only the list's own pane scroller.",
  ],
  tokens: ["--space-sm", "--space-md", "--space-xs", "--space-3xl", "--control-height-md", "--control-hit-target", "--typo-body-line-height",
    "--shadow-drag-lift", "--motion-base", "--motion-ease-spring", "--radius-control"],
};
