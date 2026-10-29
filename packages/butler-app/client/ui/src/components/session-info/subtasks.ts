import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SubtaskState, SubtaskView } from "@/app/types.ts";

/** The subtask's one muted state word. */
export function subtaskStateLabel(state: SubtaskState): string {
  const c = appCopy.sessionInfo;
  if (state === "paused") return c.subtaskPaused;
  if (state === "needs_approval") return c.subtaskNeedsApproval;
  return appCopy.space.working;
}

/** The plan step in progress, as the transcript card and observer count it. */
function planStep(subtask: SubtaskView): { step: number; total: number } | null {
  const total = subtask.plan_total, completed = subtask.plan_completed;
  if (total === undefined || completed === undefined || total < 1) return null;
  return { step: Math.min(total, Math.max(0, completed) + 1), total };
}

/** The same plan step caption the transcript card and observer show. */
export function subtaskProgress(subtask: SubtaskView): string | null {
  const plan = planStep(subtask);
  return plan ? `${plan.step}/${plan.total}` : null;
}

/** The state and, while working, the plan step in words, for assistive tech. */
export function subtaskStatus(subtask: SubtaskView): string {
  const c = appCopy.sessionInfo;
  const plan = subtask.state === "working" ? planStep(subtask) : null;
  return c.subtaskStatus(subtaskStateLabel(subtask.state), plan ? c.subtaskStep(plan.step, plan.total) : undefined);
}

/** A row's accessible name: the title, then its status. */
export function subtaskLabel(subtask: SubtaskView): string {
  return appCopy.sessionInfo.subtaskRow(subtask.title, subtaskStatus(subtask));
}

/** Opens the subtask's observer over its parent conversation. */
export async function openSubtask(parentId: string, subtask: SubtaskView) {
  const store = useButlerStore.getState();
  if (store.activeChatId !== parentId) await store.openSession(parentId);
  if (useButlerStore.getState().activeChatId === parentId) useButlerStore.getState().openSessionObserver(subtask.session_id);
}
