import { appCopy, getAppLocale } from "@/app/copy.ts";
import type { MemoryProject } from "./memoryTypes";
export interface FeedbackEntry {
  feedback_id: string; text: string; scope: string; state: string;
  project_name?: string | null; updated_at: string; expires_at: string | null;
}
export function feedbackScope(item: FeedbackEntry, projects: MemoryProject[]) {
  const copy = appCopy.settings.memory;
  if (item.scope === "global") return copy.allChats;
  if (item.scope.startsWith("session:")) return copy.feedback.thisChat;
  return item.project_name || projects.find((project) => project.id === item.scope.slice(8) || project.ledger_project_id === item.scope.slice(8))?.display_name || copy.project;
}
export function feedbackExpiry(item: FeedbackEntry) {
  const copy = appCopy.settings.memory.feedback;
  if (!item.expires_at) return item.scope.startsWith("session:") ? copy.chatEnds : copy.noExpiry;
  const remaining = Date.parse(item.expires_at) - Date.now();
  const days = Math.ceil(remaining / 86400000);
  if (days <= 0) return copy.expired;
  if (days === 1) return copy.inHours(Math.ceil(remaining / 3600000));
  if (days <= 30) return copy.inDays(days);
  return copy.onDate(new Intl.DateTimeFormat(getAppLocale(), { dateStyle: "medium" }).format(new Date(item.expires_at)));
}
