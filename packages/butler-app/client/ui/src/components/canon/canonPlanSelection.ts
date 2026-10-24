import type { CanonPlan } from "../../../../shared/canon-contracts.ts";
export function defaultCanonPlan(plans: CanonPlan[], now = new Date()): string | null {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const open = plans.filter(plan => plan.status === "open");
  const future = open.filter(plan => plan.due_on && plan.due_on >= today)
    .sort((a, b) => a.due_on!.localeCompare(b.due_on!) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return (future[0] ?? open.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0])?.id ?? null;
}
