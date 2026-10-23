import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { EpicCard as CardData } from "@/app/canonApi.ts";
import { Card, Presence, Stack, Tag, Typo } from "@/butler-ds";
import { CanonStatusGlyph } from "./CanonStatusGlyph.tsx";
export function EpicCard({ epic, ordinal, selected, onSelect }: {
  epic: CardData; ordinal?: number; selected: boolean; onSelect: (id: string) => void;
}) {
  useAppLocale();
  const copy = appCopy.canon;
  const caption = [ordinal ? copy.ordinal(ordinal) : "", epic.task_counts.total ? copy.tasks(epic.task_counts.completed ?? 0, epic.task_counts.total) : ""].filter(Boolean).join(" · ");
  return <Presence present motion="fade"><Card interactive selected={selected} padding="sm" onClick={() => onSelect(epic.id)}
    aria-label={epic.title} aria-pressed={selected} data-epic-id={epic.id} data-test-class="canon-epic-card">
    <Stack gap="sm">
      <Stack align="row" cross="start" gap="sm">
        <CanonStatusGlyph status={epic.canon_status} />
        <Typo.Body lineClamp={2} grow>{epic.title}</Typo.Body>
      </Stack>
      {caption && <Typo.Caption numeric="tabular" tone="secondary">{caption}</Typo.Caption>}
      {epic.canon_status === "cancelled" && <Tag>{copy.statuses.cancelled}</Tag>}
    </Stack>
  </Card></Presence>;
}
