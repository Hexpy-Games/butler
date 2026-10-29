import { canonTaskCounts } from "./canonProgressSource.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { EpicCard as CardData } from "@/app/canonApi.ts";
import { KanbanCard, Stack, Tag, Typo } from "@/butler-ds";
import { CanonTagList } from "./CanonTagList.tsx";
import { CanonAvatar } from "./CanonAvatar.tsx";
import { CanonEpicActivity } from "./CanonEpicStatus.tsx";
export function EpicCard({ epic, ordinal, selected, onSelect }: {
  epic: CardData; ordinal?: number; selected: boolean; onSelect: (id: string) => void;
}) {
  useAppLocale();
  const copy = appCopy.canon;
  const counts = canonTaskCounts(epic);
  const caption = [ordinal ? copy.ordinal(ordinal) : "", counts.total ? copy.tasks(counts.completed ?? 0, counts.total) : ""].filter(Boolean).join(" · ");
  return <KanbanCard itemId={epic.id} label={epic.title} selected={selected} onOpen={() => onSelect(epic.id)}>
    <Stack gap="sm">
      <Stack align="row" cross="center" gap="sm">
        <CanonEpicActivity epic={epic} />
        <Typo.Body data-test-class="canon-epic-title" truncate shrink minWidth="0">{epic.title}</Typo.Body>
        <Stack shrink={false}><CanonAvatar agent={epic.agent} person={epic.assignee} /></Stack>
      </Stack>
      <CanonTagList tags={epic.tags} limit={3} />
      {caption && <Typo.Caption numeric="tabular" tone="secondary">{caption}</Typo.Caption>}
      {epic.canon_status === "cancelled" && <Tag>{copy.statuses.cancelled}</Tag>}
    </Stack>
  </KanbanCard>;
}
