import type {
  NewChatBriefingLocale,
  NewChatBriefingTitleBucket,
} from "../../../../agent/cognition/consolidation/new-chat-briefing.ts";

export function userFacingProjectName(projectName: string): string {
  return projectName === "butler" ? "Butler" : projectName;
}

export function formatMoment(
  date: Date,
  locale: NewChatBriefingLocale,
): string {
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function timeOfDay(date: Date): NewChatBriefingTitleBucket {
  const hour = date.getHours();
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}
