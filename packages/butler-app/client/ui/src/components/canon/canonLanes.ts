import { canFinishCanonEpic } from "./canonProgressSource.ts";
import { applyKanbanMove, type KanbanMove } from "@/butler-ds";
import type { CanonOverview, CanonStatus, EpicCard } from "@/app/canonApi.ts";

export const CANON_LANES = ["planned", "in_progress", "in_review", "blocked", "done"] as const;
export const laneStatus = (status: CanonStatus): CanonStatus => status === "cancelled" ? "done" : status;
export const canonLaneId = (planId: string | null, status: CanonStatus = "planned"): string => planId ? `${planId}:${status}` : "backlog";
export function parseCanonLane(id: string): { planId: string | null; status: CanonStatus | null } {
  if (id === "backlog") return { planId: null, status: null };
  const separator = id.lastIndexOf(":");
  const status = id.slice(separator + 1);
  if (separator < 1 || !CANON_LANES.some(lane => lane === status)) throw new Error("Invalid canon lane");
  return { planId: id.slice(0, separator), status: status as CanonStatus };
}
export function canonCards(canon: CanonOverview): EpicCard[] {
  return [...canon.backlog, ...canon.plans.flatMap(plan => plan.works)];
}
/** Preserve the complete interleaved canon order, including cards in other lanes. */
export function movedCanonOrder(cards: EpicCard[], move: KanbanMove): string[] {
  const ids = cards.filter(card => card.id !== move.itemId).map(card => card.id);
  let at = move.beforeItemId ? ids.indexOf(move.beforeItemId) : -1;
  if (move.beforeItemId === null) {
    const { status } = parseCanonLane(move.toLaneId);
    const last = cards.filter(card => card.id !== move.itemId && (!status || laneStatus(card.canon_status) === status)).at(-1);
    at = last ? ids.indexOf(last.id) + 1 : ids.length;
  }
  ids.splice(at < 0 ? ids.length : at, 0, move.itemId);
  return ids;
}
export function optimisticCanonMove(canon: CanonOverview, move: KanbanMove): CanonOverview {
  const cards = canonCards(canon);
  const epic = cards.find(card => card.id === move.itemId)!;
  const target = parseCanonLane(move.toLaneId);
  const lanes: Record<string, string[]> = { backlog: canon.backlog.map(card => card.id) };
  for (const plan of canon.plans) for (const status of CANON_LANES) {
    lanes[canonLaneId(plan.id, status)] = plan.works.filter(card => laneStatus(card.canon_status) === status).map(card => card.id);
  }
  const moved = applyKanbanMove(lanes, move);
  const updated = { ...epic, plan_id: target.planId,
    canon_status: !target.status || target.status === laneStatus(epic.canon_status)
      ? epic.canon_status : target.status };
  const byId = new Map(cards.map(card => [card.id, card.id === epic.id ? updated : card]));
  return { ...canon, backlog: moved.backlog!.map(id => byId.get(id)!), plans: canon.plans.map(plan => {
    const works = plan.works.filter(card => card.id !== epic.id);
    if (plan.id !== target.planId) return { ...plan, works };
    const order = movedCanonOrder(plan.works, move);
    return { ...plan, works: order.map(id => byId.get(id)!) };
  }) };
}
export function canComplete(card: EpicCard | undefined, toLaneId: string): boolean {
  if (!card) return false;
  return parseCanonLane(toLaneId).status !== "done" || canFinishCanonEpic(card);
}
