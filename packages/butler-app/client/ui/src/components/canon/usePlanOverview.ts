import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { editCanonEpic, orderCanonPlan, orderCanonBacklog, type EpicCard, type EpicInput } from "@/app/canonApi.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { useCanonBoard } from "./useCanonBoard.ts";
import { canonWriteFailure } from "./canonFeedback.ts";
export function usePlanOverview(projectId: string, planId: string | null) {
  const board = useCanonBoard(projectId);
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  const plan = board.canon?.plans.find(plan => plan.id === planId);
  const original = planId ? plan?.works ?? [] : board.canon?.backlog ?? [];
  const byId = new Map(original.map(epic => [epic.id, epic]));
  const rows = optimistic ? optimistic.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) : original;
  const write = async (epic: EpicCard, input: EpicInput, message: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await editCanonEpic(epic.id, { ...input, expected_revision: epic.revision });
      notifyStatus(message); await board.refresh();
    } catch (error) { await canonWriteFailure(error, board.refresh); }
    finally { setBusy(false); }
  };
  const reorder = async (ids: string[]) => {
    if (busy || !board.canon) return;
    setBusy(true); setOptimistic(ids);
    try {
      if (plan) await orderCanonPlan(plan.id, { work_ids: ids, expected_revision: plan.revision });
      else await orderCanonBacklog(projectId, { work_ids: ids, expected_revision: board.canon.backlog_revision });
      notifyStatus(appCopy.canon.reordered); await board.refresh();
    } catch (error) { await canonWriteFailure(error, board.refresh); }
    finally { setOptimistic(null); setBusy(false); }
  };
  return { ...board, plan, rows, busy, write, reorder };
}
