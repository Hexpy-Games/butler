import { canonStatusInput } from "./canonProgressSource.ts";
import { editCanonEpic, orderCanonBacklog, orderCanonPlan, type CanonOverview } from "@/app/canonApi.ts";
import { appCopy } from "@/app/copy.ts";
import type { KanbanMove } from "@/butler-ds";
import { canonCards, laneStatus, movedCanonOrder, parseCanonLane } from "./canonLanes.ts";

export async function persistCanonMove(canon: CanonOverview, move: KanbanMove): Promise<string> {
  const from = parseCanonLane(move.fromLaneId), to = parseCanonLane(move.toLaneId);
  const epic = canonCards(canon).find(card => card.id === move.itemId)!;
  const plan = canon.plans.find(plan => plan.id === to.planId);
  if (move.fromLaneId === move.toLaneId) {
    const work_ids = movedCanonOrder(plan?.works ?? canon.backlog, move);
    if (plan) await orderCanonPlan(plan.id, { work_ids, expected_revision: plan.revision });
    else await orderCanonBacklog(canon.project_id, { work_ids, expected_revision: canon.backlog_revision });
    return appCopy.canon.reordered;
  }
  const status = to.status && to.status !== laneStatus(epic.canon_status) ? to.status : undefined;
  await editCanonEpic(epic.id, { expected_revision: epic.revision,
    ...(from.planId !== to.planId ? { plan_id: to.planId, ...(move.beforeItemId ? { before_id: move.beforeItemId } : {}) } : {}),
    ...(status ? canonStatusInput(epic, status) : {}),
  });
  return from.planId !== to.planId ? appCopy.canon.moved(plan?.title ?? appCopy.canon.backlog)
    : appCopy.canon.cardStatusChanged(epic.title, to.status === "blocked" ? appCopy.canon.blockedLane : appCopy.canon.statuses[to.status!]);
}
