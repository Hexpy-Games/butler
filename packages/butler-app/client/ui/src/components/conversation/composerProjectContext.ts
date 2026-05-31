import type { NavigationView } from "@/app/types.ts";
import { isDraftChatId, parseDraftChatId } from "@/app/utils.ts";

export function activeProjectId(
  navigation: NavigationView,
  activeChatId: string,
): string | null {
  const draft = parseDraftChatId(activeChatId);
  if (draft.kind === "project") return draft.projectId ?? null;
  if (isDraftChatId(activeChatId)) return null;
  for (const project of navigation.projects ?? []) {
    if ((project.sessions ?? []).some((session) => session.id === activeChatId)) {
      return project.id;
    }
  }
  return null;
}
