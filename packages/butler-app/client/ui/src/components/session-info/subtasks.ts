import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SubtaskState, SubtaskView } from "@/app/types.ts";
import { stewardPlanProgress } from "../conversation/stewardProgressPresentation.ts";

/** The subtask's one muted state word. */
export function subtaskStateLabel(state: SubtaskState): string {
  const c = appCopy.sessionInfo;
  if (state === "paused") return c.subtaskPaused;
  if (state === "needs_approval") return c.subtaskNeedsApproval;
  return appCopy.space.working;
}

/** The same plan step caption the transcript card and observer show. */
export function subtaskProgress(subtask: SubtaskView): string | null {
  return stewardPlanProgress({ approved_plan_total: subtask.plan_total, approved_plan_completed: subtask.plan_completed });
}

/** Opens the subtask's observer over its parent conversation. */
export async function openSubtask(parentId: string, subtask: SubtaskView) {
  const store = useButlerStore.getState();
  if (store.activeChatId !== parentId) await store.openSession(parentId);
  if (useButlerStore.getState().activeChatId === parentId) useButlerStore.getState().openSessionObserver(subtask.session_id);
}
