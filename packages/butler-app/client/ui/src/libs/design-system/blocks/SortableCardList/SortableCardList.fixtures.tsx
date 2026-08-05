import { useState } from "react";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { SortableCardList, type SortableCardListItem } from "./SortableCardList";

const initialItems: SortableCardListItem[] = [
  { id: "claude", label: "Claude Sonnet", title: "Claude Sonnet", meta: "Anthropic", description: "Balanced reasoning" },
  { id: "gemini", label: "Gemini Flash", title: "Gemini Flash", meta: "Google", description: "Fast multimodal model" },
  { id: "grok", label: "Grok", title: "Grok", meta: "xAI", description: "Long-context model" },
];

export function SortableCardListFixture() {
  const [items, setItems] = useState(initialItems);
  const [showEmpty, setShowEmpty] = useState(false);
  return (
    <Stack gap="xl">
      <SortableCardList
        title="Backup models"
        description="Drag with a pointer or keyboard to change priority."
        items={showEmpty ? [] : items}
        onReorder={setItems}
        onRemove={(id) => setItems((current) => current.filter((item) => item.id !== id))}
        actions={
          <Button variant="outline" size="sm" onClick={() => setShowEmpty((value) => !value)}>
            {showEmpty ? "Show cards" : "Show empty"}
          </Button>
        }
      />
      <SortableCardList
        title="Reduced-motion empty state"
        items={[]}
        onReorder={setItems}
        emptyMessage="Add a model to create a backup chain."
      />
    </Stack>
  );
}
