import { CriteriaProgress } from "./CriteriaProgress.tsx";
import { canonTaskCounts } from "./canonProgressSource.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { CanonStatus, EpicCard as CardData } from "@/app/canonApi.ts";
import { KanbanCard, Stack, Tag, Typo, type TagTone } from "@/butler-ds";
import { CanonTagList } from "./CanonTagList.tsx";
import { CanonAvatar } from "./CanonAvatar.tsx";
import { CanonEpicActivity } from "./CanonEpicStatus.tsx";
import { CanonStatusGlyph } from "./CanonStatusGlyph.tsx";
const STATUS_TONES: Record<CanonStatus, TagTone> = { planned: "neutral", in_progress: "accent", in_review: "warning", blocked: "danger", done: "success", cancelled: "neutral" };
export function EpicCard({ epic, ordinal, selected, onSelect, showStatus }: {
  /** Outside the board there is no lane, so the card shows its status itself. */
  showStatus?: boolean;
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
      <CriteriaProgress criteria={epic.criteria} />
      <CanonTagList tags={epic.tags} limit={3} />
      {caption && <Typo.Caption numeric="tabular" tone="secondary">{caption}</Typo.Caption>}
      {showStatus ? <Tag icon={<CanonStatusGlyph status={epic.canon_status} />} tone={STATUS_TONES[epic.canon_status]} data-test-class="canon-epic-status">{copy.statuses[epic.canon_status]}</Tag>
        : epic.canon_status === "cancelled" && <Tag data-test-class="canon-epic-status">{copy.statuses.cancelled}</Tag>}
    </Stack>
  </KanbanCard>;
}
