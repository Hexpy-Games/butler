import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { EpicCard as CardData } from "@/app/canonApi.ts";
import { KanbanCard, Stack, Tag, Typo } from "@/butler-ds";
import { CanonAvatar } from "./CanonAvatar.tsx";
import { CanonStatusGlyph } from "./CanonStatusGlyph.tsx";
export function EpicCard({ epic, ordinal, selected, onSelect }: {
  epic: CardData; ordinal?: number; selected: boolean; onSelect: (id: string) => void;
}) {
  useAppLocale();
  const copy = appCopy.canon;
  const caption = [ordinal ? copy.ordinal(ordinal) : "", epic.task_counts.total ? copy.tasks(epic.task_counts.completed ?? 0, epic.task_counts.total) : ""].filter(Boolean).join(" · ");
  return <KanbanCard itemId={epic.id} label={epic.title} selected={selected} onOpen={() => onSelect(epic.id)}>
    <Stack gap="sm">
      <Stack align="row" cross="start" gap="sm">
        <CanonStatusGlyph status={epic.canon_status} />
        <Typo.Body lineClamp={2} shrink>{epic.title}</Typo.Body>
        <CanonAvatar person={epic.assignee} />
      </Stack>
      {caption && <Typo.Caption numeric="tabular" tone="secondary">{caption}</Typo.Caption>}
      {epic.canon_status === "cancelled" && <Tag>{copy.statuses.cancelled}</Tag>}
    </Stack>
  </KanbanCard>;
}
