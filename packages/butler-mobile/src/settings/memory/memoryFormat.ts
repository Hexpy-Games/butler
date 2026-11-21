import type { AppCopy } from "../../../../butler-i18n/src/index.ts";
import type { Instruction, MemoryCard, NoticedPattern, ProjectMemory } from "../types";
import { formatFileSize, relativeAge } from "../format";

// Desktop: MemoryFacts.tsx:9-26.
export function facts(card: MemoryCard | undefined, project: ProjectMemory | undefined, app: AppCopy, locale: string): string {
  const copy = app.settings.memory;
  if (card && card.item_count == null && card.allocated_bytes == null && card.pending_count == null) return copy.notMeasured;
  const items: string[] = [];
  const count = (label: string, value?: number | null) => { if (value != null) items.push(`${label} ${new Intl.NumberFormat(locale).format(value)}`); };
  const size = (label: string, value?: number | null) => { if (value != null) items.push(`${label} ${formatFileSize(value)}`); };
  if (project) {
    if (project.summary_bytes === null) items.push(`${copy.facts.summary} ${copy.none}`);
    else size(copy.facts.summary, project.summary_bytes);
    count(copy.facts.chats, project.conversations); count(copy.facts.instructions, project.instructions);
  } else if (card) {
    count(card.kind === "pinned" ? copy.facts.instructions : card.kind === "profile" ? copy.facts.entries : copy.facts.chats, card.item_count);
    if (card.kind === "profile") count(copy.facts.candidates, card.pending_count);
    if (card.kind !== "pinned") size(copy.facts.size, card.allocated_bytes);
  }
  const updated = project?.updated_at ?? card?.content_updated_at;
  if (updated) items.push(`${copy.facts.updated} ${copy.ago(relativeAge(updated, app))}`);
  if (card?.kind === "automatic") size(copy.facts.canFree, card.health.reclaimable_bytes);
  return items.join(" · ") || copy.notMeasured;
}

// Desktop: consolidationTime.ts.
export function formatConsolidationTime(at: string, locale: string, words: { today: string; yesterday: string }, now = new Date()) {
  const date = new Date(at), yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const day = sameDay(date, now) ? words.today : sameDay(date, yesterday) ? words.yesterday : new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date);
  return `${day} ${new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date)}`;
}

// Desktop: useInstructions.ts and InstructionRow.tsx:11-13.
export function instructionScope(item: Instruction, copy: AppCopy["settings"]["memory"]) {
  return item.scope.kind === "session" ? copy.thisChat : item.scope.kind === "all" ? copy.allChats : item.scope.project_name || copy.project;
}
export function instructionMeta(item: Instruction, copy: AppCopy["settings"]["memory"]) {
  const hours = Math.max(1, Math.ceil((Date.parse(item.expires_at ?? "") - Date.now()) / 3_600_000));
  const duration = item.duration === "this chat" ? copy.thisChatOnly : !item.expires_at || item.duration === "always" ? ""
    : hours <= 24 ? copy.expiresInHours(hours) : copy.expiresInDays(Math.ceil(hours / 24));
  return item.scope.kind === "session" && item.duration === "this chat" ? duration
    : [instructionScope(item, copy), item.duration === "always" ? "" : duration].filter(Boolean).join(" · ");
}

// Desktop: usePatterns.ts:16-22.
export function patternMeta(item: NoticedPattern, copy: AppCopy["settings"]["memory"]) {
  const days = Math.max(1, Math.ceil((Date.now() - Date.parse(item.evidence.first_at)) / 86_400_000));
  const weeks = Math.floor(days / 7);
  const span = days < 14 ? copy.patternDays(days) : weeks < 9 ? copy.patternWeeks(weeks) : copy.patternMonths(Math.max(1, Math.floor(days / 30)));
  return `${span} · ${copy.patternCount(item.evidence.count)}`;
}
