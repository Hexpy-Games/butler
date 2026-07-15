import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import {
  TURN_COMPLETION_EVIDENCE_EVENT_KIND,
  TURN_OUTCOME_EVENT_KIND,
  createCompletionEvidencePayload,
  createTurnOutcomePayload,
  type CompletionEvidenceKind,
} from "../../../events/turn-state-contract.ts";
import {
  type TerminalTurnState,
  type TurnKernelController,
} from "../../turn-kernel.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import type { ToolAuditEntry } from "../output/tool-types.ts";
import { unresolvedValidationFailureFromAudit } from "./validation-failure-guard.ts";

export async function emitSuccessfulTurnOutcome(input: {
  turnInput: RuntimeTurnInput;
  audit: ToolAuditEntry[];
  limitedDelivery: boolean;
  turnKernel: TurnKernelController;
  turnId?: string;
}): Promise<void> {
  const validationFailure = unresolvedValidationFailureFromAudit(input.audit);
  const evidenceRefs = await emitCompletionEvidenceFromAudit(input.turnInput, input.audit);
  if (validationFailure) {
    await emitTurnEventBestEffort(input.turnInput, {
      kind: TURN_OUTCOME_EVENT_KIND,
      payload: createKernelTurnOutcomePayload({
        turnKernel: input.turnKernel,
        to: "completed",
        completionEvidenceRefs: evidenceRefs,
        publicSummary: `Delivered with an unresolved validation limitation: ${validationFailure.suite}`,
        reason: "final_delivery_completed_with_validation_limitation",
      }),
    });
    return;
  }
  await emitTurnEventBestEffort(input.turnInput, {
    kind: TURN_OUTCOME_EVENT_KIND,
    payload: createKernelTurnOutcomePayload({
      turnKernel: input.turnKernel,
      to: "completed",
      completionEvidenceRefs: evidenceRefs,
      completionEvidenceStatus: evidenceRefs.length === 0 ? "not_required" : undefined,
      publicSummary: input.limitedDelivery ? "Completed with limitations." : "Completed.",
      reason: input.limitedDelivery ? "final_delivery_completed_with_limitations" : "final_delivery_completed",
    }),
  });
}

export async function emitInterruptedTurnOutcome(input: {
  turnInput: RuntimeTurnInput;
  cancelled: true;
  reason: string;
  turnKernel: TurnKernelController;
}): Promise<void> {
  const evidenceRef = `turn:${input.turnInput.handle.sessionId}:cancelled`;
  await emitTurnEventBestEffort(input.turnInput, {
    kind: TURN_COMPLETION_EVIDENCE_EVENT_KIND,
    payload: createCompletionEvidencePayload({
      evidenceKind: "cancelled",
      status: "cancelled",
      summary: "Turn was cancelled before final delivery.",
      refs: [evidenceRef],
    }),
  });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: TURN_OUTCOME_EVENT_KIND,
    payload: createKernelTurnOutcomePayload({
      turnKernel: input.turnKernel,
      to: "aborted",
      eventOutcome: "cancelled",
      completionEvidenceRefs: [evidenceRef],
      publicSummary: "Cancelled.",
      reason: input.reason,
    }),
  });
}

export function createKernelTurnOutcomePayload(input: {
  turnKernel: TurnKernelController;
  to: TerminalTurnState;
  eventOutcome?: "completed" | "failed" | "runtime_fault" | "cancelled" | "waiting_user";
  completionEvidenceRefs: string[];
  completionEvidenceStatus?: string;
  recoveryToken?: string;
  publicSummary: string;
  reason: string;
}): Record<string, unknown> {
  const terminal = input.turnKernel.terminalize({
    to: input.to,
    reason: input.reason,
    evidenceRefs: input.completionEvidenceRefs,
  });
  return createTurnOutcomePayload({
    outcome: input.eventOutcome ?? terminal.to,
    completionEvidenceRefs: terminal.evidenceRefs,
    completionEvidenceStatus: input.completionEvidenceStatus,
    recoveryToken: input.recoveryToken,
    publicSummary: input.publicSummary,
  });
}

async function emitCompletionEvidenceFromAudit(
  input: RuntimeTurnInput,
  audit: ToolAuditEntry[],
): Promise<string[]> {
  const receipts = audit
    .flatMap((entry) => entry.evidenceCapabilityReceipts ?? [])
    .filter((receipt) =>
      receipt.maturity === "verified" ||
      receipt.verified ||
      receipt.capability === "validation_passed",
    );
  const refs: string[] = [];
  for (const receipt of receipts) {
    const evidenceKind = completionEvidenceKindForCapability(receipt.capability, receipt.verified);
    if (!evidenceKind) continue;
    const ref = `receipt:${receipt.receipt_id}`;
    await emitTurnEventBestEffort(input, {
      kind: TURN_COMPLETION_EVIDENCE_EVENT_KIND,
      payload: createCompletionEvidencePayload({
        evidenceKind,
        status: receipt.verified ? "verified" : receipt.maturity,
        summary: receipt.summary,
        refs: [ref, ...receipt.references.flatMap(completionEvidenceRefsForReceiptReference)],
      }),
    });
    refs.push(ref);
  }
  return Array.from(new Set(refs));
}

function completionEvidenceKindForCapability(
  capability: string,
  verified: boolean,
): CompletionEvidenceKind | null {
  if (capability === "source_verified") return "source_verified";
  if (capability === "command_executed") return "command_executed";
  if (capability === "validation_passed") return verified ? "test_passed" : "test_failed";
  if (capability === "durable_artifact" || capability === "data_table_created" || capability === "chart_rendered") {
    return "artifact_exists";
  }
  if (capability === "browser_observed") return "route_verified";
  if (capability === "explicit_blocker") return "user_decision_required";
  if (capability === "limitation_recorded") return "provider_failed";
  return null;
}

function completionEvidenceRefsForReceiptReference(reference: {
  url?: string;
  path?: string;
  artifact_id?: string;
  tool_call_id?: string;
  task_id?: string;
}): string[] {
  return [
    reference.url ? `url:${reference.url}` : null,
    reference.path ? `path:${reference.path}` : null,
    reference.artifact_id ? `artifact:${reference.artifact_id}` : null,
    reference.tool_call_id ? `tool:${reference.tool_call_id}` : null,
    reference.task_id ? `task:${reference.task_id}` : null,
  ].filter((value): value is string => Boolean(value));
}
