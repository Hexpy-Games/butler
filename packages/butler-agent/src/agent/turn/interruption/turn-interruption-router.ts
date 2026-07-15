import { createHash } from "node:crypto";
import {
  TURN_INTERRUPTION_ENVELOPE_SCHEMA,
  TURN_INTERRUPTION_RECEIPT_SCHEMA,
  TURN_RECOVERY_CASE_SCHEMA,
  RUNTIME_INTERRUPTION_CODES,
  type RuntimeInterruptionEnvelope,
  type TurnInterruptionDirective,
  type TurnInterruptionEnvelope,
} from "./turn-interruption-types.ts";

export const RUNTIME_UNCLASSIFIED_INTERRUPTION =
  "runtime_unclassified_interruption" as const;

export function routeTurnInterruption(
  envelope: TurnInterruptionEnvelope,
): TurnInterruptionDirective {
  validateEnvelopeBase(envelope);
  switch (envelope.kind) {
    case "internal_incompletion":
      requireRef(envelope.continuationCheckpointRef, "continuation_checkpoint");
      return {
        kind: "continue_same_turn",
        turnId: envelope.turnId,
        attemptId: envelope.attemptId,
        expectedGeneration: envelope.currentGeneration,
        checkpointRef: envelope.continuationCheckpointRef,
      };
    case "user_authority_required":
      requireRef(envelope.ownerRef, "user_wait_owner");
      return {
        kind: "waiting_user",
        turnId: envelope.turnId,
        attemptId: envelope.attemptId,
        expectedGeneration: envelope.currentGeneration,
        checkpointRef: envelope.lastStableCheckpointRef,
        ownerRef: envelope.ownerRef,
      };
    case "external_authority_required":
      requireRef(envelope.ownerRef, "external_wait_owner");
      requireRef(envelope.wakeRevisionRef, "external_wake_revision");
      return {
        kind: "waiting_external",
        turnId: envelope.turnId,
        attemptId: envelope.attemptId,
        expectedGeneration: envelope.currentGeneration,
        checkpointRef: envelope.lastStableCheckpointRef,
        ownerRef: envelope.ownerRef,
        wakeRevisionRef: envelope.wakeRevisionRef,
      };
    case "runtime_interruption":
      return runtimeWaitDirective(envelope);
    case "user_cancellation":
      if (envelope.cancellationGeneration !== envelope.currentGeneration) {
        throw new Error("turn_cancellation_generation_mismatch");
      }
      requireRef(envelope.cancellationReceiptRef, "cancellation_receipt");
      return {
        kind: "cancelled",
        turnId: envelope.turnId,
        attemptId: envelope.attemptId,
        expectedGeneration: envelope.currentGeneration,
        checkpointRef: envelope.lastStableCheckpointRef,
        cancellationReceiptRef: envelope.cancellationReceiptRef,
        createdAt: envelope.createdAt,
      };
    default:
      return assertNever(envelope);
  }
}

export function runtimeInterruptionFromUnknown(input: Omit<
  RuntimeInterruptionEnvelope,
  "schemaVersion" | "kind" | "diagnosticCode"
> & { error: unknown }): RuntimeInterruptionEnvelope {
  void input.error;
  const { error: _error, ...bounded } = input;
  return {
    ...bounded,
    schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
    kind: "runtime_interruption",
    diagnosticCode: RUNTIME_UNCLASSIFIED_INTERRUPTION,
  };
}

function runtimeWaitDirective(
  envelope: RuntimeInterruptionEnvelope,
): TurnInterruptionDirective {
  requireRef(envelope.resumePredicateRef, "runtime_resume_predicate");
  const diagnosticCode = envelope.diagnosticCode ??
    RUNTIME_UNCLASSIFIED_INTERRUPTION;
  if (!RUNTIME_INTERRUPTION_CODES.includes(diagnosticCode)) {
    throw new Error("turn_interruption_diagnostic_code_invalid");
  }
  const diagnosticRefs = boundedRefs(envelope.diagnosticRefs, 16);
  const availableControlRefs = boundedRefs(
    envelope.availableControlRefs ?? ["turn.stop"],
    8,
  );
  const progressFingerprint = stableHash({
    turnId: envelope.turnId,
    attemptId: envelope.attemptId,
    checkpointRef: envelope.lastStableCheckpointRef,
    pendingOperationRef: envelope.pendingOperationRef,
    sideEffectState: envelope.sideEffectState,
    resumePredicateRef: envelope.resumePredicateRef,
    wakeRevisionRef: envelope.wakeRevisionRef,
  });
  const recoveryCaseId = `recovery-${stableHash({
    turnId: envelope.turnId,
    interruptionId: envelope.interruptionId,
  }).slice(0, 24)}`;
  const interruptionReceipt = {
    schemaVersion: TURN_INTERRUPTION_RECEIPT_SCHEMA,
    interruptionId: envelope.interruptionId,
    turnId: envelope.turnId,
    attemptId: envelope.attemptId,
    origin: envelope.origin,
    diagnosticCode,
    lastStableCheckpointRef: envelope.lastStableCheckpointRef,
    ...(envelope.pendingOperationRef
      ? { pendingOperationRef: envelope.pendingOperationRef }
      : {}),
    sideEffectState: envelope.sideEffectState,
    resumePredicateRef: envelope.resumePredicateRef,
    ...(envelope.wakeRevisionRef
      ? { wakeRevisionRef: envelope.wakeRevisionRef }
      : {}),
    progressFingerprint,
    diagnosticRefs,
    createdAt: envelope.createdAt,
  } as const;
  return {
    kind: "waiting_runtime",
    turnId: envelope.turnId,
    attemptId: envelope.attemptId,
    expectedGeneration: envelope.currentGeneration,
    checkpointRef: envelope.lastStableCheckpointRef,
    interruptionReceipt,
    recoveryCase: {
      schemaVersion: TURN_RECOVERY_CASE_SCHEMA,
      recoveryCaseId,
      turnId: envelope.turnId,
      attemptId: envelope.attemptId,
      interruptionId: envelope.interruptionId,
      origin: envelope.origin,
      diagnosticCode,
      lastStableCheckpointRef: envelope.lastStableCheckpointRef,
      ...(envelope.pendingOperationRef
        ? { pendingOperationRef: envelope.pendingOperationRef }
        : {}),
      sideEffectState: envelope.sideEffectState,
      owner: "turn_runtime_recovery",
      resumePredicateRef: envelope.resumePredicateRef,
      ...(envelope.wakeRevisionRef
        ? { wakeRevisionRef: envelope.wakeRevisionRef }
        : {}),
      progressFingerprint,
      diagnosticRefs,
      publicStatusId: envelope.publicStatusId?.trim() || "runtime_recovery_pending",
      availableControlRefs,
      status: "open",
      createdAt: envelope.createdAt,
    },
  };
}

function validateEnvelopeBase(envelope: TurnInterruptionEnvelope): void {
  if (envelope.schemaVersion !== TURN_INTERRUPTION_ENVELOPE_SCHEMA) {
    throw new Error("turn_interruption_schema_invalid");
  }
  requireRef(envelope.interruptionId, "interruption_id");
  requireRef(envelope.turnId, "turn_id");
  requireRef(envelope.attemptId, "attempt_id");
  requireRef(envelope.origin, "interruption_origin");
  requireRef(envelope.lastStableCheckpointRef, "stable_checkpoint");
  requireRef(envelope.createdAt, "interruption_created_at");
  if (!Number.isInteger(envelope.currentGeneration) || envelope.currentGeneration < 1) {
    throw new Error("turn_interruption_generation_invalid");
  }
}

function requireRef(value: string, field: string): void {
  if (!value.trim()) throw new Error(`turn_interruption_${field}_missing`);
}

function boundedRefs(refs: readonly string[], limit: number): string[] {
  const result: string[] = [];
  for (const candidate of refs) {
    const ref = candidate.trim();
    if (!ref || result.includes(ref)) continue;
    result.push(ref.slice(0, 240));
    if (result.length === limit) break;
  }
  return result;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertNever(value: never): never {
  void value;
  throw new Error("turn_interruption_kind_invalid");
}
