import { useButlerStore } from "@/app/store.ts";
import type { MessageRecord } from "@/app/types.ts";
import { BranchMessageActions } from "./BranchMessageActions";
import { activeProjectId } from "./composerProjectContext";

const BRANCHABLE_STATUSES = ["delivered", "completed", "sent"];

/**
 * Branch actions for a settled answer in `general` or a project session. From
 * a project session the new conversation stays in that project.
 */
export function AssistantBranchActions({ message }: { message: MessageRecord }) {
  const sessionId = message.chat_id ?? "";
  const projectId = useButlerStore((state) =>
    sessionId === "general" ? null : activeProjectId(state.navigation, sessionId));
  const settled = Boolean(message.text.trim()) &&
    (!message.status || BRANCHABLE_STATUSES.includes(message.status));
  if (!settled || (sessionId !== "general" && !projectId)) return null;
  return <BranchMessageActions sessionId={sessionId} messageId={message.id} projectId={projectId} />;
}
