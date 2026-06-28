import { expect, test } from "bun:test";
import {
  AUTHORED_DECISION_SOURCES,
  COMPLETION_EVIDENCE_KINDS,
  RECOVERY_KINDS,
  RUNTIME_FAULT_EVENT_KIND,
  TURN_ACKNOWLEDGED_EVENT_KIND,
  TURN_COMPLETION_EVIDENCE_EVENT_KIND,
  TURN_DECISION_EVENT_KIND,
  TURN_OUTCOME_EVENT_KIND,
  TURN_OUTCOMES,
  createDiagnosticInvariantViolationPayload,
  createCompletionEvidencePayload,
  createRuntimeFaultPayload,
  createRecoveryRecordedPayload,
  createTurnAcknowledgedPayload,
  createTurnDecisionPayload,
  createTurnOutcomePayload,
  isAuthoredDecisionSource,
} from "../../packages/butler-agent/src/agent/events/turn-state-contract.ts";
import { createAgentTurnEvent } from "../../packages/butler-agent/src/agent/events/turn-events.ts";

test("turn state contract event kinds are accepted by the canonical event creator", () => {
  const fixtures = [
    {
      kind: TURN_ACKNOWLEDGED_EVENT_KIND,
      payload: { safeLabel: "Request received", transport: "app" },
    },
    {
      kind: TURN_DECISION_EVENT_KIND,
      payload: {
        decisionId: "decision-1",
        summary: "Check the projection contract",
        source: "assistant-authored",
      },
    },
    {
      kind: TURN_COMPLETION_EVIDENCE_EVENT_KIND,
      payload: {
        evidenceKind: "command_executed",
        status: "ok",
        summary: "Command ran",
        refs: ["receipt-1"],
      },
    },
    {
      kind: TURN_OUTCOME_EVENT_KIND,
      payload: {
        outcome: "completed",
        completionEvidenceRefs: ["evidence-1"],
        publicSummary: "Completed with evidence",
      },
    },
    {
      kind: RUNTIME_FAULT_EVENT_KIND,
      payload: {
        faultId: "fault-1",
        turnId: "turn",
        kind: "provider_stream_corruption",
        retryable: true,
        publicSummary: "Runtime stream was interrupted.",
        operatorSummary: "Provider stream emitted an invalid tool result frame.",
        createdAt: "2026-06-28T00:00:00.000Z",
      },
    },
  ] as const;

  for (const [index, fixture] of fixtures.entries()) {
    const event = createAgentTurnEvent({
      sessionId: "session",
      turnId: "turn",
      sessionSequence: index + 1,
      turnSequence: index + 1,
      kind: fixture.kind,
      payload: fixture.payload,
    });
    expect(event.kind).toBe(fixture.kind);
  }
});

test("turn acknowledged payload is deterministic public receipt, not a decision", () => {
  const payload = createTurnAcknowledgedPayload({
    safeLabel: "요청을 받았습니다. 바로 작업을 정리하겠습니다.",
    transport: "app",
  });

  expect(payload).toEqual({
    safeLabel: "요청을 받았습니다. 바로 작업을 정리하겠습니다.",
    transport: "app",
  });
  expect(payload.decisionSummary).toBeUndefined();
  expect(payload.summary).toBeUndefined();
});

test("public decision payloads require assistant-authored sources", () => {
  for (const source of AUTHORED_DECISION_SOURCES) {
    expect(isAuthoredDecisionSource(source)).toBe(true);
    expect(createTurnDecisionPayload({
      decisionId: `decision-${source}`,
      summary: "Check the projection contract",
      rationale: "The next change depends on the source authority boundary.",
      nextStep: "Apply the source gate to projection helpers.",
      source,
      evidenceRefs: ["turn-state-contract"],
    })).toMatchObject({
      source,
      summary: "Check the projection contract",
    });
  }

  for (const source of ["model-authored", "principal-authored", "runtime-derived", "review-repaired", "tool-metadata"]) {
    expect(isAuthoredDecisionSource(source)).toBe(false);
    expect(() => createTurnDecisionPayload({
      decisionId: `decision-${source}`,
      summary: "Fallback",
      source,
    })).toThrow("public turn decision source must be authored");
  }
});

test("canonical turn decision events reject unauthorised public decision sources", () => {
  expect(() => createAgentTurnEvent({
    sessionId: "session",
    turnId: "turn",
    sessionSequence: 1,
    turnSequence: 1,
    kind: TURN_DECISION_EVENT_KIND,
    payload: {
      decisionId: "decision-runtime",
      summary: "Fallback",
      source: "runtime-derived",
    },
  })).toThrow("public turn decision source must be authored");
});

test("completion evidence payload validates known evidence kinds", () => {
  for (const evidenceKind of COMPLETION_EVIDENCE_KINDS) {
    expect(createCompletionEvidencePayload({
      evidenceKind,
      status: "ok",
      summary: "Evidence recorded",
      refs: ["receipt-1"],
    })).toMatchObject({ evidenceKind, refs: ["receipt-1"] });
  }

  expect(() => createCompletionEvidencePayload({
    evidenceKind: "todo_checked",
    status: "ok",
    summary: "Process bookkeeping is not completion evidence",
  })).toThrow("unknown completion evidence kind");
});

test("turn outcome payload enforces evidence and recovery-token invariants", () => {
  for (const outcome of TURN_OUTCOMES) {
    if (outcome === "completed") {
      expect(createTurnOutcomePayload({
        outcome,
        completionEvidenceRefs: ["evidence-1"],
        publicSummary: "Completed with evidence.",
      })).toMatchObject({ outcome, completionEvidenceRefs: ["evidence-1"] });
      expect(createTurnOutcomePayload({
        outcome,
        completionEvidenceStatus: "not_required",
        publicSummary: "Completed without external evidence requirement.",
      })).toMatchObject({ outcome, completionEvidenceStatus: "not_required" });
    } else if (outcome === "recoverable" || outcome === "waiting_user") {
      expect(createTurnOutcomePayload({
        outcome,
        recoveryToken: `recovery-${outcome}`,
        publicSummary: "The turn can resume from recovery state.",
      })).toMatchObject({ outcome, recoveryToken: `recovery-${outcome}` });
    } else {
      expect(createTurnOutcomePayload({
        outcome,
        publicSummary: "The turn ended without successful completion.",
      })).toMatchObject({ outcome });
    }
  }

  expect(() => createTurnOutcomePayload({
    outcome: "completed",
    publicSummary: "No evidence.",
  })).toThrow("completed turn outcome requires completion evidence refs or not_required evidence status");

  expect(() => createTurnOutcomePayload({
    outcome: "completed",
    completionEvidenceStatus: "unknown",
    publicSummary: "Invalid evidence status.",
  })).toThrow("turn outcome completion evidence status must be not_required");

  expect(() => createTurnOutcomePayload({
    outcome: "recoverable",
    publicSummary: "Missing token.",
  })).toThrow("recoverable turn outcome requires a recovery token");
});

test("runtime fault payload enforces exact recovery contract", () => {
  for (const kind of RECOVERY_KINDS) {
    expect(createRuntimeFaultPayload({
      faultId: `fault-${kind}`,
      turnId: "turn-1",
      kind,
      retryable: false,
      publicSummary: "Runtime stopped before the turn could continue.",
      operatorSummary: "Operator diagnostic for the runtime fault.",
      createdAt: "2026-06-28T00:00:00.000Z",
    })).toMatchObject({
      faultId: `fault-${kind}`,
      kind,
      retryable: false,
      publicSummary: "Runtime stopped before the turn could continue.",
      operatorSummary: "Operator diagnostic for the runtime fault.",
    });
  }

  expect(() => createRuntimeFaultPayload({
    faultId: "fault-invalid",
    turnId: "turn-1",
    kind: "tool_result_pairing_invariant",
    retryable: true,
    publicSummary: "Runtime stopped.",
    operatorSummary: "Invalid kind.",
  })).toThrow("unknown runtime fault recovery kind");

  expect(() => createRuntimeFaultPayload({
    faultId: "fault-missing-retryable",
    turnId: "turn-1",
    kind: "provider_stream_corruption",
    publicSummary: "Runtime stopped.",
    operatorSummary: "Missing retryability.",
    retryable: undefined,
  })).toThrow("runtime fault retryable must be an explicit boolean");

  expect(() => createRuntimeFaultPayload({
    faultId: "fault-missing-operator",
    turnId: "turn-1",
    kind: "provider_stream_corruption",
    retryable: true,
    publicSummary: "Runtime stopped.",
    operatorSummary: undefined,
  })).toThrow("runtime fault operator summary is required");
});

test("recovery and diagnostic payload helpers validate stable control surfaces", () => {
  expect(createRecoveryRecordedPayload({
    recoveryToken: "recovery-1",
    reason: "Turn interrupted before completion evidence was recorded.",
    workStreamId: "workstream-1",
    todoListId: "todo-1",
    supportedControls: ["resume", "cancel", "archive"],
  })).toEqual({
    recoveryToken: "recovery-1",
    reason: "Turn interrupted before completion evidence was recorded.",
    workStreamId: "workstream-1",
    todoListId: "todo-1",
    supportedControls: ["resume", "cancel", "archive"],
  });

  expect(createDiagnosticInvariantViolationPayload({
    invariant: "runtime-derived decision hidden",
    severity: "warning",
    summary: "A repaired decision was recorded as diagnostic-only.",
    refs: ["turn-1"],
  })).toEqual({
    invariant: "runtime-derived decision hidden",
    severity: "warning",
    summary: "A repaired decision was recorded as diagnostic-only.",
    refs: ["turn-1"],
  });

  expect(() => createRecoveryRecordedPayload({
    recoveryToken: undefined,
    reason: "No token.",
  })).toThrow("recovery token is required");

  expect(() => createDiagnosticInvariantViolationPayload({
    invariant: "bad severity",
    severity: "fatal",
    summary: "Unsupported severity.",
  })).toThrow("diagnostic invariant severity must be warning or error");
});
