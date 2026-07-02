import { recordOperationalMetric } from "../../operations/metrics/operational-metrics.ts";
import type { AdmissionDecision, ConversationAdmissionInput } from "./admission.ts";

export interface ConversationAdmissionMetricInput {
  butlerData?: string;
  sessionRole?: string;
  sessionId?: string;
  decision: AdmissionDecision;
  event: ConversationAdmissionInput;
}

export function recordConversationAdmissionMetric(input: ConversationAdmissionMetricInput): void {
  recordOperationalMetric({
    category: "runtime",
    name: "conversation_admission",
    status: input.decision.admitted ? "ok" : "skipped",
    value: 1,
    unit: "event",
    dimensions: {
      admitted: input.decision.admitted,
      admission_class: input.decision.className,
      event_kind: input.decision.eventKind,
      reason: input.decision.reason,
      source: input.event.source,
      session_role: input.sessionRole ?? null,
      session_id_present: Boolean(input.sessionId),
      orphan_tool_result_rejected: input.decision.reason === "orphan_tool_result_rejected",
    },
  }, { butlerData: input.butlerData });
}
