import type { ModelRequestAdmissionReceipt } from "../../integrations/providers/shared/request-context-admission.ts";

export type OverflowRecoveryDecision =
  | { action: "retry"; receipt: ModelRequestAdmissionReceipt }
  | {
    action: "recoverable";
    reason: "binding_changed" | "request_not_smaller" | "request_not_admitted" | "cancelled";
  };

/**
 * Tracks one logical turn's invariant-recovery boundary. It has no retry count:
 * progress is authorized exclusively by a strictly smaller admitted request
 * with the same turn and model binding.
 */
export class MonotonicOverflowRecovery {
  private lastReceipt: ModelRequestAdmissionReceipt;
  private cancelled = false;

  constructor(admittedOverflowReceipt: ModelRequestAdmissionReceipt) {
    this.lastReceipt = admittedOverflowReceipt;
  }

  cancel(): void {
    this.cancelled = true;
  }

  consider(rebuilt: ModelRequestAdmissionReceipt): OverflowRecoveryDecision {
    if (this.cancelled) return { action: "recoverable", reason: "cancelled" };
    if (
      rebuilt.plan.turn_id !== this.lastReceipt.plan.turn_id ||
      rebuilt.plan.model_ref !== this.lastReceipt.plan.model_ref
    ) {
      return { action: "recoverable", reason: "binding_changed" };
    }
    if (rebuilt.plan.admission !== "admitted") {
      return { action: "recoverable", reason: "request_not_admitted" };
    }
    if (rebuilt.plan.compiled_input_tokens >= this.lastReceipt.plan.compiled_input_tokens) {
      return { action: "recoverable", reason: "request_not_smaller" };
    }
    this.lastReceipt = rebuilt;
    return { action: "retry", receipt: rebuilt };
  }
}
