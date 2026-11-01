import { useCanonSidebarState } from "@/app/canonSidebarState.ts";
import { useButlerStore } from "@/app/store.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import { useSessionViewLoad } from "@/app/sessionViewLoad.ts";
import { useActiveCanonEpic } from "../canon/useActiveCanonEpic.ts";
import { useSessionCanonQueue } from "./useSessionCanonQueue.ts";
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
  const firstEpic = useActiveCanonEpic();
  const asks = usePendingAsks(sessionId);
  const order = useSessionCanonQueue(sessionId);
  const currentStep = order.view?.chains.flatMap(chain => chain.steps).flatMap(step => step.items).find(item => item.state === "running")?.epic_id;
  const stepEpic = useCanonSidebarState(state => state.sessions[sessionId]?.find(match => match.epic.id === currentStep));
  const epic = stepEpic ?? firstEpic;
  const notDone = order.view?.chains.reduce((count, chain) => count + chain.steps.reduce((sum, step) => sum + step.items.filter(item => item.state !== "done").length, 0), 0) ?? 0;
  const browserTabs = useConversationAgentTabs(sessionId);
  const branch = summary?.branch_info;
  const folder = branch?.workspace_path || branch?.workspace_label;
  const artifacts = summary?.artifacts ?? [];
  const attachments = [...new Map(messages.flatMap(message => message.attachments ?? []).map(file => [file.file_id, file])).values()];
  const schedules = summary?.automation_targets ?? [];
  const subtasks = summary?.subtasks ?? [];
  const waiting = queue.filter(item => item.chat_id === sessionId && ["queued", "dispatching"].includes(item.state));
  const hasArtifacts = artifacts.length > 0 || messages.some(message => message.artifacts?.length);
  const ids: string[] = [];
  // The summary's sections sit above the task: showing any section while it loads would push them down when it lands.
  // A failed load settles too, and then the sections that need no summary show.
  const summaryPending = isServerBackedSessionId(sessionId) && !summary && !loadSettled;
  if (!summaryPending) {
    if (asks && asks.open_count > 0) ids.push("asks");
    if (subtasks.length > 0) ids.push("subtasks");
    if (notDone > 0) ids.push("order");
    if (browserTabs.length > 0 && canOpenHandoffTab()) ids.push("browser");
    if (folder || branch?.branch_name) ids.push("environment");
    if (epic) ids.push("task");
    if (summary?.context_details) ids.push("context");
    if (hasArtifacts) ids.push("artifacts");
    if (attachments.length > 0) ids.push("attachments");
    if (schedules.length > 0) ids.push("schedules");
    if (waiting.length > 0) ids.push("queue");
  }
  return { order, notDone, ids, sessionId, summary, epic, asks, subtasks, browserTabs, branch, folder, artifacts, attachments, schedules, waiting };
}

export function useSessionInfoHasContent() {
  return useSessionSectionsModel().ids.length > 0;
}
