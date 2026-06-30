import { expect, test } from "bun:test";
import {
  AUTHORED_DECISION_SOURCES,
  COMPLETION_EVIDENCE_KINDS,
  PUBLIC_DECISION_ROLES,
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
  isPublicDecisionRole,
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
        role: "tool_intent",
        summary: "Check the projection contract",
        rationale: "The event contract needs the model-authored reason.",
        nextStep: "Use this decision before visible work.",
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

test("public decision payloads require authored sources", () => {
  for (const role of PUBLIC_DECISION_ROLES) {
    expect(isPublicDecisionRole(role)).toBe(true);
  }

  for (const source of AUTHORED_DECISION_SOURCES) {
    expect(isAuthoredDecisionSource(source)).toBe(true);
    expect(createTurnDecisionPayload({
      decisionId: `decision-${source}`,
      role: "tool_intent",
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

  for (const source of ["runtime-derived", "review-repaired", "tool-metadata"]) {
    expect(isAuthoredDecisionSource(source)).toBe(false);
    expect(() => createTurnDecisionPayload({
      decisionId: `decision-${source}`,
      role: "tool_intent",
      summary: "Fallback",
      rationale: "Fallback rationale",
      nextStep: "Fallback next step",
      source,
    })).toThrow("public turn decision source must be authored");
  }
});

test("public decision payloads require valid explicit roles", () => {
  expect(() => createTurnDecisionPayload({
    decisionId: "decision-missing-role",
    role: undefined,
    summary: "Check the projection contract",
    rationale: "The role boundary is part of the public event contract.",
    nextStep: "Reject legacy decision calls without a role.",
    source: "assistant-authored",
  })).toThrow("turn decision role is required");

  expect(() => createTurnDecisionPayload({
    decisionId: "decision-unknown-role",
    role: "first_progress",
    summary: "Check the projection contract",
    rationale: "Fallback progress is not a public decision role.",
    nextStep: "Reject unknown decision roles.",
    source: "assistant-authored",
  })).toThrow("unknown turn decision role: first_progress");
});

test("opening decisions require model authored semantic fields and first visible status", () => {
  expect(createTurnDecisionPayload({
    decisionId: "decision-opening",
    role: "opening",
    summary: "Clarify the requested event contract boundary.",
    rationale: "The user asked for the contract slice only.",
    nextStep: "Update the typed payload validation before runtime generation work.",
    source: "model-authored",
    firstVisible: true,
  })).toMatchObject({
    role: "opening",
    source: "model-authored",
    firstVisible: true,
  });

  expect(() => createTurnDecisionPayload({
    decisionId: "decision-opening-assistant",
    role: "opening",
    summary: "Clarify the requested event contract boundary.",
    rationale: "The user asked for the contract slice only.",
    nextStep: "Update the typed payload validation before runtime generation work.",
    source: "assistant-authored",
    firstVisible: true,
  })).toThrow("opening decision source must be model-authored");

  expect(() => createTurnDecisionPayload({
    decisionId: "decision-opening-hidden",
    role: "opening",
    summary: "Clarify the requested event contract boundary.",
    rationale: "The user asked for the contract slice only.",
    nextStep: "Update the typed payload validation before runtime generation work.",
    source: "model-authored",
    firstVisible: false,
  })).toThrow("opening decision firstVisible must be true");
});

test("runtime fallback progress cannot be accepted as an opening decision", () => {
  const acknowledged = createTurnAcknowledgedPayload({
    safeLabel: "Request received. Preparing the work.",
    transport: "app",
  });
  expect(acknowledged).toEqual({
    safeLabel: "Request received. Preparing the work.",
    transport: "app",
  });

  expect(() => createTurnDecisionPayload({
    decisionId: "decision-ack-copy",
    role: "opening",
    summary: acknowledged.safeLabel,
    rationale: "Receipt copy is transport acknowledgement, not model-authored semantics.",
    nextStep: "Keep acknowledgement outside assistant.decision.",
    source: "assistant-authored",
    firstVisible: true,
  })).toThrow("opening decision source must be model-authored");

  expect(() => createTurnDecisionPayload({
    decisionId: "decision-runtime-fallback",
    role: "opening",
    summary: "Request received. Preparing the work.",
    rationale: "Gateway fallback text is not model-authored semantic output.",
    nextStep: "Keep receipt text outside assistant.decision.",
    source: "runtime-derived",
    firstVisible: true,
  })).toThrow("public turn decision source must be authored");

  expect(() => createAgentTurnEvent({
    sessionId: "session",
    turnId: "turn",
    sessionSequence: 1,
    turnSequence: 1,
    kind: TURN_DECISION_EVENT_KIND,
    payload: {
      decisionId: "decision-first-progress-fallback",
      role: "opening",
      summary: "Working",
      rationale: "First-progress fallback text is runtime policy output.",
      nextStep: "Do not promote it to an opening decision.",
      source: "runtime-derived",
      firstVisible: true,
    },
  })).toThrow("public turn decision source must be authored");
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
      role: "tool_intent",
      summary: "Fallback",
      rationale: "Runtime text is not authored public decision output.",
      nextStep: "Reject this payload.",
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
    } else if (outcome === "waiting_user") {
      expect(createTurnOutcomePayload({
        outcome,
        publicSummary: "The turn is waiting for user action.",
      })).toMatchObject({ outcome });
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
    recoveryToken: "legacy-recovery",
    publicSummary: "Recoverable is not a public turn outcome.",
  })).toThrow("unknown turn outcome: recoverable");
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
    faultId: undefined,
    turnId: "turn-1",
    kind: "provider_stream_corruption",
    retryable: true,
    publicSummary: "Runtime stopped.",
    operatorSummary: "Missing fault id.",
    createdAt: "2026-06-28T00:00:00.000Z",
  })).toThrow("runtime fault id is required");

  expect(() => createRuntimeFaultPayload({
    faultId: "fault-missing-turn",
    turnId: undefined,
    kind: "provider_stream_corruption",
    retryable: true,
    publicSummary: "Runtime stopped.",
    operatorSummary: "Missing turn id.",
    createdAt: "2026-06-28T00:00:00.000Z",
  })).toThrow("runtime fault turn id is required");

  expect(() => createRuntimeFaultPayload({
    faultId: "fault-invalid",
    turnId: "turn-1",
    kind: "tool_result_pairing_invariant",
    retryable: true,
    publicSummary: "Runtime stopped.",
    operatorSummary: "Invalid kind.",
    createdAt: "2026-06-28T00:00:00.000Z",
  })).toThrow("unknown runtime fault recovery kind");

  expect(() => createRuntimeFaultPayload({
    faultId: "fault-missing-retryable",
    turnId: "turn-1",
    kind: "provider_stream_corruption",
    publicSummary: "Runtime stopped.",
    operatorSummary: "Missing retryability.",
    retryable: undefined,
    createdAt: "2026-06-28T00:00:00.000Z",
  })).toThrow("runtime fault retryable must be an explicit boolean");

  expect(() => createRuntimeFaultPayload({
    faultId: "fault-missing-operator",
    turnId: "turn-1",
    kind: "provider_stream_corruption",
    retryable: true,
    publicSummary: "Runtime stopped.",
    operatorSummary: undefined,
    createdAt: "2026-06-28T00:00:00.000Z",
  })).toThrow("runtime fault operator summary is required");

  expect(() => createRuntimeFaultPayload({
    faultId: "fault-missing-created",
    turnId: "turn-1",
    kind: "provider_stream_corruption",
    retryable: true,
    publicSummary: "Runtime stopped.",
    operatorSummary: "Missing createdAt.",
    createdAt: undefined,
  })).toThrow("runtime fault createdAt is required");
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
