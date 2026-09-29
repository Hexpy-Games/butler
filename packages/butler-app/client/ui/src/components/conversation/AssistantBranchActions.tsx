import { useButlerStore } from "@/app/store.ts";
import type { MessageRecord, NavigationView } from "@/app/types.ts";
import { BranchMessageActions } from "./BranchMessageActions";

const BRANCHABLE_STATUSES = ["delivered", "completed", "sent"];
// One session → project index per navigation snapshot, shared by every message.
const projectIndexes = new WeakMap<NavigationView, Map<string, string>>();

function projectIdOf(navigation: NavigationView, sessionId: string): string | null {
  let index = projectIndexes.get(navigation);
  if (!index) {
    index = new Map(navigation.projects.flatMap((project) =>
      (project.sessions ?? []).map((session) => [session.id, project.id] as const)));
    projectIndexes.set(navigation, index);
  }
  return index.get(sessionId) ?? null;
}

/**
 * Branch actions for a settled answer in `general` or a project session. From
 * a project session the new conversation stays in that project.
 */
export function AssistantBranchActions({ message }: { message: MessageRecord }) {
  const sessionId = message.chat_id ?? "";
  const projectId = useButlerStore((state) =>
    sessionId === "general" ? null : projectIdOf(state.navigation, sessionId));
  const settled = Boolean(message.text.trim()) &&
    (!message.status || BRANCHABLE_STATUSES.includes(message.status));
  if (!settled || (sessionId !== "general" && !projectId)) return null;
  return <BranchMessageActions sessionId={sessionId} messageId={message.id} projectId={projectId} />;
}
