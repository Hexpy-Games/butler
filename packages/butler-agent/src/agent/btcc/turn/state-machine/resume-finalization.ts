import type { GoalContractAcceptedProduct } from "../../conception/index.ts";
import type { FinalizationContinuation } from "../../continuation/index.ts";
import { contentRef, digest } from "../../core/index.ts";
import type { PreparedReportProduct } from "../../reporting/index.ts";
import type {
  AcceptedTurnTransition,
  DeliveryOutbox,
  TurnRecord,
} from "../contracts.ts";

export function resumeFinalization(
  turn: TurnRecord,
  product: GoalContractAcceptedProduct,
  finalization: FinalizationContinuation,
): Extract<AcceptedTurnTransition, { kind: "accept_finalization_continuation" }> {
  if (finalization.resumeAt === "consolidation") {
    return {
      kind: "accept_finalization_continuation",
      successor: "consolidation",
      product,
      finalization,
    };
  }
  if (finalization.resumeAt === "reporting") {
    return {
      kind: "accept_finalization_continuation",
      successor: "reporting",
      product,
      finalization,
    };
  }
  const preparedReport = rebindPreparedReport(turn.turnId, finalization.preparedReport);
  const deliveryOutbox = createDeliveryOutbox(turn, preparedReport);
  return {
    kind: "accept_finalization_continuation",
    successor: "delivery_committed",
    product,
    finalization,
    preparedReport,
    deliveryOutbox,
  };
}

function rebindPreparedReport(
  turnId: string,
  source: PreparedReportProduct,
): PreparedReportProduct {
  const finalPayloadBody = {
    turnId,
    reportRef: source.report.ref,
    finalDossierRef: source.report.finalDossierRef,
    contentSha256: source.report.contentSha256,
    route: "managed" as const,
    disposition: source.finalPayload.disposition,
    content: source.report.content,
  };
  return {
    kind: "prepared_report",
    report: source.report,
    finalPayload: { ref: contentRef("payload", finalPayloadBody), ...finalPayloadBody },
  };
}

function createDeliveryOutbox(
  turn: TurnRecord,
  product: PreparedReportProduct,
): DeliveryOutbox {
  const committedRevision = turn.revision + 1;
  const payload = product.finalPayload;
  const outboxId = digest(
    `btcc-canonical-delivery.v1\0${turn.turnId}\0${committedRevision}\0${payload.ref.sha256}`,
  );
  return {
    outboxId,
    finalPayloadRef: payload.ref,
    expectedMessageId: digest(`btcc-assistant-message.v1\0${outboxId}`),
    content: payload.content,
    status: "pending",
  };
}
