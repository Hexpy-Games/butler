import { appCopy } from "@/app/copy.ts";
import type { PhaseActivity } from "@/app/conversation-progress";

export function delegatedRequestGoal(activity: PhaseActivity, goal?: string): string {
  // Legacy delegated plans copied the worker brief into the initial note.
  // Only the explicitly quoted original request is suitable for this surface.
  if (goal?.trim()) return goal.replace(/\s+/gu, " ").trim();
  const request = /(?:사용자 요청|User request):\s*(?:'(.+?)'(?=\s|$)|"(.+?)"(?=\s|$)|‘(.+?)’|“(.+?)”)/iu.exec(activity.summary);
  if (/(?:사용자 요청|User request):/iu.test(activity.summary)) {
    const title = /(?:사용자 요청|User request):/iu.test(activity.title)
      ? appCopy.guided.tools.start_work! : activity.title;
    return (request?.slice(1).find(Boolean) ?? title).replace(/\s+/gu, " ").trim();
  }
  return activity.summary;
}
