import type { PrincipalTurnCancellationTarget } from "../../../../agent/turn/principal-turn-cancellation-control.ts";
import {
  markPrincipalTurnCancellationDelivery,
  principalTurnCancellationRecorded,
} from "../../../../agent/turn/principal-turn-cancellation-registry.ts";
import {
  NativeInboundQueue,
  type DeadOwnerCancellationSettlementOutcome,
} from "../../../core/inbound-queue.ts";

export type PrincipalDeadOwnerCancellationSettlementOutcome =
  | DeadOwnerCancellationSettlementOutcome
  | "decision_not_cancelled"
  | "pending_claim"
  | "settlement_failed";

export function settlePrincipalDeadOwnerCancellation(
  target: PrincipalTurnCancellationTarget,
): PrincipalDeadOwnerCancellationSettlementOutcome {
  if (!target.dispatchClaimId) return "pending_claim";
  if (!principalTurnCancellationRecorded({
    butlerData: target.butlerData,
    turnId: target.turnId,
  })) {
    return "decision_not_cancelled";
  }
  const identity = {
    butlerData: target.butlerData,
    turnId: target.turnId,
    queueId: target.queueId,
    dispatchClaimId: target.dispatchClaimId,
  };
  try {
    const outcome = new NativeInboundQueue(target.butlerData)
      .settleDeadOwnerCancellation(identity);
    if (outcome === "completed" || outcome === "already_completed") {
      markPrincipalTurnCancellationDelivery(identity, "completed");
    }
    return outcome;
  } catch {
    return "settlement_failed";
  }
}
