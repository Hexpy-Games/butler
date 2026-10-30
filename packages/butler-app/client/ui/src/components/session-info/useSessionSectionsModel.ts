import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import { useButlerStore } from "@/app/store.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import { useSessionViewLoad } from "@/app/sessionViewLoad.ts";
import { useActiveCanonEpic } from "../canon/useActiveCanonEpic.ts";
import { usePendingAsks } from "./usePendingAsks.ts";
import { canOpenHandoffTab } from "../browser/browserHandoff.ts";
import { useConversationAgentTabs } from "../browser/useConversationAgentTabs.ts";

/** One ordered visibility model for the actions, layout and sections. */
export function useSessionSectionsModel() {
  const sessionId = useButlerStore(state => state.activeChatId);
  const summary = useButlerStore(state => state.summary?.session_id === sessionId ? state.summary : null);
  const loadSettled = useSessionViewLoad(state => state.settled === sessionId);
  const messages = useButlerStore(state => state.messages);
  const queue = useButlerStore(state => state.sessionQueue);
  const epic = useActiveCanonEpic();
  const asks = usePendingAsks(sessionId);
  const browserTabs = useConversationAgentTabs(sessionId);
  const branch = summary?.branch_info;
  const folder = branch?.workspace_path || branch?.workspace_label;
  const artifacts = summary?.artifacts ?? [];
  const attachments = [...new Map(messages.flatMap(message => message.attachments ?? []).map(file => [file.file_id, file])).values()];
  const schedules = summary?.automation_targets ?? [];
  const subtasks = summary?.subtasks ?? [];
  const waiting = queue.filter(item => item.chat_id === sessionId && ["queued", "dispatching"].includes(item.state));
  const running = (ACTIVE_TURN_STATES.has(summary?.turn_state ?? "") ? summary?.latest_progress?.safe_progress_rows : [])?.filter(row => ["running", "active", "thinking", "streaming", "reviewing", "waiting_for_tool"].includes(row.state ?? "")) ?? [];
  const hasArtifacts = artifacts.length > 0 || messages.some(message => message.artifacts?.length);
  const ids: string[] = [];
  // The summary's sections sit above the task: showing any section while it loads would push them down when it lands.
  // A failed load settles too, and then the sections that need no summary show.
  const summaryPending = isServerBackedSessionId(sessionId) && !summary && !loadSettled;
  if (!summaryPending) {
    if (asks && asks.open_count > 0) ids.push("asks");
    if (subtasks.length > 0) ids.push("subtasks");
    if (browserTabs.length > 0 && canOpenHandoffTab()) ids.push("browser");
    if (folder || branch?.branch_name) ids.push("environment");
    if (epic) ids.push("task");
    if (summary?.context_details) ids.push("context");
    if (hasArtifacts) ids.push("artifacts");
    if (attachments.length > 0) ids.push("attachments");
    if (schedules.length > 0) ids.push("schedules");
    if (running.length > 0 || waiting.length > 0) ids.push("queue");
  }
  return { ids, sessionId, summary, epic, asks, subtasks, browserTabs, branch, folder, artifacts, attachments, schedules, running, waiting };
}

export function useSessionInfoHasContent() {
  return useSessionSectionsModel().ids.length > 0;
}
