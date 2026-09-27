import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { CardList, CardListItem } from "../CardList";
import { SortableCardList, type SortableCardListItem } from "./index";

const MODELS: SortableCardListItem[] = [
  { id: "claude", label: "Claude Sonnet", title: "Claude Sonnet", meta: "Anthropic" },
  { id: "gemini", label: "Gemini Flash", title: "Gemini Flash", meta: "Google" },
];

// #region recipe: Backup model order
function BackupOrder() {
  const [items, setItems] = useState(MODELS);
  return (
    <SortableCardList title="Backup models" description="Butler tries them in this order." items={items} onReorder={setItems}
      onRemove={(id) => setItems(items.filter((item) => item.id !== id))} emptyMessage="Add a model to create a backup chain." />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A reorderable card list (pointer and keyboard) with lift and neighbor-slide motion.",
  whenToUse: ["The order of items matters and people set it (backup models)"],
  whenNotToUse: [
    { when: "Order does not matter", use: "CardList" },
    { when: "Reordering sidebar rows", use: "NavDropTarget" },
  ],
  recipes: [{ name: "Backup model order", description: "Controlled items; onReorder receives the new order (reorderSortableCardItems does the math).", render: () => <BackupOrder /> }],
  doDont: [
    {
      do: { caption: "Drag handles and keyboard reordering.", render: () => <BackupOrder /> },
      dont: { caption: "Up/down buttons on a static list are slow and inconsistent.", render: () => <CardList><CardListItem title="Claude Sonnet" meta="1" /></CardList> },
    },
  ],
  content: ["Describe what the order means (Butler tries them in this order)."],
  accessibility: ["dnd-kit keyboard sensor: Space to lift, arrows to move, Space to drop; moves are announced."],
  tokens: ["--motion-scale-lift", "--shadow-drag-lift", "--motion-base", "--motion-ease-standard"],
};
