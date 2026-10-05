import { MetaList, Typo, type MetaListItem } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { relativeAge } from "@/app/utils.ts";
import { formatCount } from "./usageSettingsFormat";
import { formatFileSize } from "../conversation/conversationUtils";
import type { MemoryCard, ProjectMemory } from "./memoryTypes";
export function MemoryFacts({ card, project }: { card?: MemoryCard; project?: ProjectMemory }) {
  const copy = appCopy.settings.memory;
  if (card && card.item_count == null && card.allocated_bytes == null && card.pending_count == null) return <Typo.Caption tone="tertiary">{copy.notMeasured}</Typo.Caption>;
  const items: MetaListItem[] = [];
  const count = (label: string, value?: number | null) => { if (value != null) items.push({ label, value: formatCount(value) }); };
  const size = (label: string, value?: number | null) => { if (value != null) items.push({ label, value: formatFileSize(value) }); };
  if (project) {
    if (project.summary_bytes === null) items.push({ label: copy.facts.summary, value: copy.none });
    else size(copy.facts.summary, project.summary_bytes);
    count(copy.facts.chats, project.conversations);
    count(copy.facts.instructions, project.instructions);
  } else if (card) {
    count(card.kind === "pinned" ? copy.facts.instructions : card.kind === "profile" ? copy.facts.entries : copy.facts.chats, card.item_count);
    if (card.kind === "profile") count(copy.facts.candidates, card.pending_count);
    if (card.kind !== "pinned") size(copy.facts.size, card.allocated_bytes);
  }
  const updated = project?.updated_at ?? card?.content_updated_at;
  if (updated) items.push({ label: copy.facts.updated, value: copy.ago(relativeAge(updated)) });
  if (card?.kind === "automatic" && card.health.reclaimable_bytes) size(copy.facts.canFree, card.health.reclaimable_bytes);
  return items.length ? <MetaList items={items} /> : <Typo.Caption tone="tertiary">{copy.notMeasured}</Typo.Caption>;
}
