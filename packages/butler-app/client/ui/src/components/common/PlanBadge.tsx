import type { ButlerAccountStatus } from "@/app/butlerAccount";
import { appCopy } from "@/app/copy";
import { Badge } from "@/butler-ds";

/** Plans from lowest to highest (the cloud's quota tiers); each covers every feature of the plans before it. */
const PLAN_ORDER = ["free", "plus", "pro", "enterprise"] as const;
type Plan = (typeof PLAN_ORDER)[number];
export type PaidPlan = Exclude<Plan, "free">;

/** A plan this build does not know ranks as Free. */
function planRank(plan: string): number {
  return Math.max(0, PLAN_ORDER.indexOf(plan as Plan));
}

export function isPaidPlan(plan: string): boolean {
  return planRank(plan) > 0;
}

/**
 * The badge on a feature that needs `required`, with a tooltip naming the plan. It takes the account status its
 * caller already holds: `undefined` (still loading) and a plan that covers the feature show nothing; signed out,
 * a lower plan or `null` (the account service did not answer) show the badge.
 */
export function PlanBadge({ required, status }: { required: PaidPlan; status: ButlerAccountStatus | null | undefined }) {
  if (status === undefined) return null;
  if (status?.signed_in && planRank(status.entitlements.plan) >= planRank(required)) return null;
  const copy = appCopy.butlerAccount;
  return <Badge tooltip={copy.planAndAbove(copy.plans[required])}>{copy.plans[required]}</Badge>;
}
