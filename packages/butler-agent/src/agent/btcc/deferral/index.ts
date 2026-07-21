export type {
  ManagedDeferralContext,
  ManagedDeferralProduct,
  ManagedDeferralSource,
  ManagedReadinessCondition,
  PromotionDeferralProduct,
} from "./contracts.ts";
export {
  withManagedDeferral,
  withTaskExecutionDeferral,
} from "./decode-managed-deferral.ts";
export { withManagedDeferralState } from "./managed-deferral-state.ts";
export {
  managedDeferralSubmissionSchema,
  promotionDeferralSubmissionSchema,
  withManagedDeferralSchema,
  withTaskExecutionDeferralSchema,
} from "./submission-schema.ts";

import type { ManagedDeferralProduct } from "./contracts.ts";

export function isManagedDeferral(value: { kind: string }): value is ManagedDeferralProduct {
  return value.kind === "managed_deferral";
}

export function isPromotionDeferral(
  value: { kind: string },
): value is import("./contracts.ts").PromotionDeferralProduct {
  return value.kind === "promotion_deferral";
}
