import {
  assertPromotionPermit,
  type BtccPersistenceTypes,
  canCloseImplementationFrontier,
  type WorkLedgerCommit,
} from "../../../../btcc/gateway-api.ts";

type ManagedProgramState = BtccPersistenceTypes["managedProgramState"];

export function validateFrontierMutation(
  previous: ManagedProgramState | null,
  commit: WorkLedgerCommit,
): void {
  if (commit.mutation.kind !== "close_implementation_frontier") return;
  if (!previous || previous.planningState !== "reviewed") {
    throw new Error("Work Ledger promotion permit has no reviewed Program");
  }
  if (!canCloseImplementationFrontier(previous)) {
    throw new Error("Work Ledger implementation frontier is not dependency-ready");
  }
  assertPromotionPermit({
    programId: previous.programId,
    currentAuthorityRef: previous.authorityRef,
    acceptedPlanRef: previous.plan.ref,
    planningReviewRef: previous.planningReviewRef,
    assemblies: commit.mutation.promotionAssemblies,
    permit: commit.mutation.promotionPermit,
  });
}
