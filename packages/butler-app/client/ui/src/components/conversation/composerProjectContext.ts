import type { NavigationView } from "@/app/types.ts";
import { draftSessionTarget, isDraftChatId } from "@/app/utils.ts";

export function activeProjectId(
  navigation: NavigationView,
  activeChatId: string,
): string | null {
  if (activeChatId.startsWith("dashboard:")) return activeChatId.slice("dashboard:".length);
  if (isDraftChatId(activeChatId)) return draftSessionTarget(navigation, activeChatId).projectId ?? null;
  for (const project of navigation.projects ?? []) {
    if ((project.sessions ?? []).some((session) => session.id === activeChatId)) {
      return project.id;
    }
  }
  return null;
}
