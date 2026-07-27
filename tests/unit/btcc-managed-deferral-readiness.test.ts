import { describe, expect, test } from "bun:test";
import {
  contentRef,
  literalSchema,
  objectSchema,
  runPhaseConversation,
  type PhaseCodec,
  type PhaseConversationStore,
  type PhaseEnvelope,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import {
  withManagedDeferral,
  withTaskExecutionDeferral,
  type ManagedDeferralContext,
  type ManagedDeferralProduct,
} from "../../packages/butler-agent/src/agent/btcc/deferral/index.ts";
import type { OperationResultProjection } from
  "../../packages/butler-agent/src/agent/btcc/operation-result/index.ts";

describe("BTCC managed deferral readiness", () => {
  test("rejects Task Execution external readiness for admitted ordinary observation scope", () => {
    const scopeRef = "workspace:/repo";
    const envelope = phaseEnvelope("task_execution", [scopeRef], [observation(scopeRef)]);

    expect(() => taskCodec.decode(externalReadiness(scopeRef), envelope)).toThrow(
      "ordinary admitted observation authority",
    );
  });

  test("rejects external readiness without a current observation for every scope", () => {
    const envelope = phaseEnvelope("planning", ["web:status"], []);

    expect(() => managedCodec.decode(externalReadiness("web:status"), envelope)).toThrow(
      "lacks a current observation",
    );
  });

  test("binds observed external readiness to current operation observation refs", () => {
    const result = observation("web:status");
    const product = managedCodec.decode(
      externalReadiness("web:status"),
      phaseEnvelope("planning", ["web:status"], [result]),
    ) as ManagedDeferralProduct;

    expect(product.blocker.readiness).toEqual({
      kind: "external_readiness",
      observationScopeRefs: ["web:status"],
      currentObservationRefs: [result.observationRef],
    });
  });

  test("preserves scheduled-time and user-authority blockers independently of observation", () => {
    const envelope = phaseEnvelope("planning", ["workspace:/repo"], []);
    const scheduled = managedCodec.decode({
      kind: "managed_deferral",
      reason: "Wait for the release window",
      readiness: { kind: "scheduled_time", notBefore: "2026-08-01T00:00:00Z" },
    }, envelope) as ManagedDeferralProduct;
    const user = managedCodec.decode({
      kind: "managed_deferral",
      reason: "Approval is required",
      readiness: {
        kind: "user_authority",
        requiredAuthorityScopeRefs: ["deployment:production"],
      },
    }, envelope) as ManagedDeferralProduct;

    expect(scheduled.blocker.readiness).toEqual({
      kind: "scheduled_time",
      notBefore: "2026-08-01T00:00:00Z",
    });
    expect(user.blocker.readiness).toEqual({
      kind: "user_authority",
      requiredAuthorityScopeRefs: ["deployment:production"],
    });
    const sameTargetAuthority = managedCodec.decode({
      kind: "managed_deferral",
      reason: "Request mutation approval for an observable target",
      readiness: {
        kind: "user_authority",
        requiredAuthorityScopeRefs: ["workspace:/repo"],
      },
    }, envelope) as ManagedDeferralProduct;
    expect(sameTargetAuthority.blocker.readiness).toEqual({
      kind: "user_authority",
      requiredAuthorityScopeRefs: ["workspace:/repo"],
    });
  });

  test("surfaces a false Task external blocker as a provider contract interruption", async () => {
    const binding = phaseEnvelope("task_execution", ["workspace:/repo"], []).binding;
    const store: PhaseConversationStore = {
      async restore<Product>() {
        return { binding, acceptedProduct: null as Product | null, operationResults: [] };
      },
      async appendOperationRound() {
        throw new Error("operation round is not expected");
      },
      async appendOperationResults() {
        throw new Error("operation results are not expected");
      },
      async appendPhaseSubmission() {
        throw new Error("invalid submission must not be persisted");
      },
      async acceptPhaseProduct() {
        throw new Error("invalid deferral must not be accepted");
      },
    };

    await expect(runPhaseConversation({
      binding,
      modelSelection,
      context: openingContext("task_execution"),
      phaseContract: {
        phase: "task_execution",
        operationSurface: "authorized",
        objective: "execute accepted task",
        duties: [],
        prohibitions: [],
      },
      codec: taskCodec,
      store,
      model: {
        async runRound() {
          return {
            kind: "phase_submission" as const,
            submission: externalReadiness("workspace:/repo"),
            actualIdentity: modelSelection,
          };
        },
      },
      operations: { perform: async () => { throw new Error("operation is not expected"); } },
      operationAuthority: {
        observationScopeRefs: ["workspace:/repo"],
        mutation: { kind: "forbidden" },
      },
      executionPermit: {
        signal: new AbortController().signal,
        assertActive() {},
        close() {},
      },
    })).rejects.toMatchObject({ code: "provider_phase_submission_invalid" });
  });
});

const baseCodec: PhaseCodec<{ kind: "ordinary" }> = {
  submissionSchema: objectSchema({ kind: literalSchema("ordinary") }),
  decode: () => ({ kind: "ordinary" }),
};
const managedCodec = withManagedDeferral(baseCodec);
const taskCodec = withTaskExecutionDeferral(baseCodec);
const modelSelection = {
  provider: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "low" as const,
  controls: {},
  controlsHash: "controls",
};

function externalReadiness(scopeRef: string) {
  return {
    kind: "managed_deferral",
    reason: "External state is not ready",
    readiness: { kind: "external_readiness", observationScopeRefs: [scopeRef] },
  };
}

function phaseEnvelope(
  phase: "planning" | "task_execution",
  observationScopeRefs: string[],
  operationResults: OperationResultProjection[],
): PhaseEnvelope {
  return {
    binding: {
      turnId: "turn-1",
      turnRevision: 1,
      semanticState: phase,
      checkpointId: "checkpoint-1",
      checkpointRevision: 1,
      claimId: "claim-1",
      executionFence: 1,
    },
    phase,
    operationSurface: "authorized",
    objective: "test managed deferral",
    duties: [],
    prohibitions: [],
    modelSelection,
    context: openingContext(phase),
    operationAuthority: { observationScopeRefs, mutation: { kind: "forbidden" } },
    operationResults,
    submissionSchema: objectSchema({}),
  };
}

function openingContext(phase: "planning" | "task_execution") {
  return {
    originalMessageId: "message-1",
    originalMessage: "perform the task",
    sessionId: "session-1",
    userRef: "user-1",
    profileRefs: [],
    recentFeedbackRefs: [],
    mandatoryHotCacheRefs: [],
    optionalHotCacheRefs: [],
    baselineObservationScopeRefs: ["workspace:/repo"],
    stateInput: { deferralContext: deferralContext(phase) },
  };
}

function deferralContext(
  sourceState: "planning" | "task_execution",
): ManagedDeferralContext {
  return {
    programId: "program-1",
    sourceState,
    requiredOutcomeId: "outcome-1",
    goalContractRef: contentRef("goal", { id: 1 }),
    authorityRef: contentRef("authority", { id: 1 }),
    planAuthority: {
      kind: "pre_plan",
      sourcePhaseEnvelopeRef: contentRef("phase-envelope", { id: 1 }),
    },
    openWorkRefs: [],
    openTaskRefs: [],
    workspaceRefs: [],
    workspaceRevisionRefs: [],
    promotionContext: { kind: "not_promotion" },
    sourceTurnId: "turn-1",
    sourceTurnRevision: 1,
  };
}

function observation(scopeRef: string): OperationResultProjection {
  return {
    resultRef: contentRef("operation-result", { scopeRef }),
    requestRef: contentRef("operation-request", { scopeRef }),
    requestId: `observe:${scopeRef}`,
    request: {
      kind: "observe",
      requestId: `observe:${scopeRef}`,
      publicTitle: "Observe readiness",
      capabilityRef: "read_status",
      scopeRef,
      input: {},
    },
    capabilityRef: "read_status",
    outcome: "observed",
    completeness: "complete",
    byteLength: 9,
    observationRef: contentRef("external-observation", { scopeRef }),
    preview: "not ready",
    content: "not ready",
    omittedBytes: 0,
    readScopeRef: `result:${encodeURIComponent(scopeRef)}`,
  };
}
