import type { ContinuationBinding } from "../continuation/index.ts";
import type { PhaseCodec } from "../core/index.ts";
import {
  withManagedDeferral,
  type ManagedDeferralProduct,
} from "../deferral/index.ts";

export type PlanningDeferralPolicy = "allow" | "consume_deferred_continuation";

export function planningDeferralPolicy(
  continuation: ContinuationBinding,
): PlanningDeferralPolicy {
  return continuation.kind === "deferred_goal"
    ? "consume_deferred_continuation"
    : "allow";
}

export function applyPlanningDeferralPolicy<Product>(
  codec: PhaseCodec<Product>,
  policy: PlanningDeferralPolicy,
): PhaseCodec<Product | ManagedDeferralProduct> {
  return policy === "allow" ? withManagedDeferral(codec) : codec;
}
