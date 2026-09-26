import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { SortableCardList, type SortableCardListItem } from "./SortableCardList";

export const meta: ShowcaseMeta = {
  title: "SortableCardList",
  category: "Settings & Forms",
  tags: ["list", "reorder", "drag", "dnd-kit", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    title: "Backup models", description: "Drag with a pointer or the keyboard to change the order Butler tries them in.",
    showEmpty: "Show empty", showCards: "Show cards", empty: "Add a model to create a backup chain.",
    models: [["claude", "Claude Sonnet", "Anthropic", "Balanced reasoning"], ["gemini", "Gemini Flash", "Google", "Fast multimodal model"], ["grok", "Grok", "xAI", "Long-context model"]],
  },
  "ko-KR": {
    title: "예비 모델", description: "포인터나 키보드로 끌어 Butler가 시도할 순서를 바꾸세요.",
    showEmpty: "빈 상태 보기", showCards: "카드 보기", empty: "모델을 추가해 예비 순서를 만드세요.",
    models: [["claude", "Claude Sonnet", "Anthropic", "균형 잡힌 추론"], ["gemini", "Gemini Flash", "Google", "빠른 멀티모달 모델"], ["grok", "Grok", "xAI", "긴 컨텍스트 모델"]],
  },
} as const;

function initialItems(context: ShowcaseRenderContext): SortableCardListItem[] {
  return labels[context.locale].models.map(([id, title, meta, description]) => ({ id, label: title, title, meta, description }));
}

/** BackupModelsSettings: drag a grip; the card lifts and neighbors slide aside. */
function BackupModels({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  const [items, setItems] = useState(() => initialItems(context));
  const [showEmpty, setShowEmpty] = useState(false);
  return (
    <SortableCardList
      title={copy.title}
      description={copy.description}
      emptyMessage={copy.empty}
      items={showEmpty ? [] : items}
      onReorder={setItems}
      onRemove={(id) => setItems((current) => current.filter((item) => item.id !== id))}
      actions={<Button variant="outline" size="sm" onClick={() => setShowEmpty((value) => !value)} text={showEmpty ? copy.showCards : copy.showEmpty} />}
    />
  );
}

export const stories: ShowcaseStory[] = [
  // Lift: --motion-scale-lift, --shadow-drag-lift and the spring; neighbors slide on --motion-base.
  { name: "Reorder with lift", states: ["drag"], widths: ["375", "app"], render: (context) => <BackupModels context={context} /> },
  {
    name: "Empty",
    render: (context) => (
      <SortableCardList title={labels[context.locale].title} items={[]} onReorder={() => undefined} emptyMessage={labels[context.locale].empty} />
    ),
  },
];
