import { createContext, useContext } from "react";
import type { MessageRecord } from "@/app/types.ts";
import { BranchMessageActions } from "./BranchMessageActions";

const BRANCHABLE_STATUSES = ["delivered", "completed", "sent"];
export const BranchProjectContext = createContext<string | null>(null);

/**
 * Branch actions for a settled answer in `general` or a project session. From
 * a project session the new conversation stays in that project.
 */
export function AssistantBranchActions({ message }: { message: MessageRecord }) {
  const sessionId = message.chat_id ?? "";
  const projectId = useContext(BranchProjectContext);
  const settled = Boolean(message.text.trim()) &&
    (!message.status || BRANCHABLE_STATUSES.includes(message.status));
  if (!settled || (sessionId !== "general" && !projectId)) return null;
  return <BranchMessageActions sessionId={sessionId} messageId={message.id} projectId={projectId} />;
}
