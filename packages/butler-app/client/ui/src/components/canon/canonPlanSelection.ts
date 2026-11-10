import type { CanonOverview, CanonPlan } from "../../../../shared/canon-contracts.ts";
export function defaultCanonPlan(plans: CanonPlan[], now = new Date()): string | null {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const open = plans.filter(plan => plan.status === "open");
  const future = open.filter(plan => plan.due_on && plan.due_on >= today)
    .sort((a, b) => a.due_on!.localeCompare(b.due_on!) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return (future[0] ?? open.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0])?.id ?? null;
}
/** The board plan holding this task: null for the backlog, undefined when the board does not have it. */
export function canonEpicPlan(canon: CanonOverview, epicId: string): string | null | undefined {
  if (canon.backlog.some(epic => epic.id === epicId)) return null;
  return canon.plans.find(plan => plan.works.some(epic => epic.id === epicId))?.id;
}
