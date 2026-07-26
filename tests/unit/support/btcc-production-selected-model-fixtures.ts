import type {
  PhaseEnvelope,
} from "../../../packages/butler-agent/src/agent/btcc/core/index.ts";
import type {
  ProviderPhasePrompt,
  ProviderPhasePromptResult,
  ProviderPhasePromptRunner,
  StructuralCapabilityDefinition,
} from "../../../packages/butler-agent/src/agent/btcc/infrastructure/model/index.ts";
import type { AcceptedPhaseGuidance } from "../../../packages/butler-agent/src/agent/btcc/guidance/index.ts";

export function phaseEnvelope(options: { emptyContext?: boolean } = {}): PhaseEnvelope {
  return {
    binding: {
      turnId: "turn-1",
      turnRevision: 4,
      semanticState: "planning",
      checkpointId: "checkpoint-1",
      checkpointRevision: 2,
      claimId: "claim-1",
      executionFence: 7,
    },
    phase: "planning",
    operationSurface: "authorized",
    objective: "Author the smallest sufficient plan.",
    duties: ["preserve_original_goal", "author_smallest_sufficient_plan"],
    prohibitions: ["no_model_substitution", "no_hidden_retry_loop"],
    exitDuties: { PlanCandidate: ["declare_verification_integration"] },
    authoringContractRefs: ["spec-authoring@1"],
    authoringContracts: [{
      contractId: "spec-authoring",
      revisionRef: { id: "spec-authoring@1", sha256: "authoring-hash" },
      applicableRules: ["one-concern-per-spec"],
    }],
    modelSelection: modelSelection(),
    context: {
      originalMessageId: "message-1",
      originalMessage: "Improve Sandy's trust profiling without changing her voice.",
      sessionId: "session-1",
      userRef: "user-1",
      projectRef: "project-1",
      profileRefs: options.emptyContext ? [] : ["profile:1"],
      recentFeedbackRefs: options.emptyContext ? [] : ["feedback:1"],
      mandatoryHotCacheRefs: options.emptyContext ? [] : ["hot:mandatory"],
      optionalHotCacheRefs: options.emptyContext ? [] : ["hot:optional"],
      baselineObservationScopeRefs: ["web:current"],
      stateInput: {
        acceptedGoalRef: "goal:1",
        managedLedgerBindingRef: "ledger:1",
      },
    },
    operationAuthority: {
      observationScopeRefs: ["web:current"],
      mutation: { kind: "forbidden" },
    },
    operationResults: [{
      requestId: "prior-observation",
      request: {
        requestId: "prior-observation",
        publicTitle: "Test operation",
        kind: "observe",
        capabilityRef: "web:search",
        scopeRef: "web:current",
        input: { query: "Current trust policy research" },
      },
      outcome: "observed",
      resultRef: { id: "result:1", sha256: "result-hash" },
      requestRef: { id: "request:1", sha256: "request-hash" },
      capabilityRef: "web:search",
      completeness: "complete",
      byteLength: 53,
      observationRef: { id: "observation:1", sha256: "observation-hash" },
      preview: "Trust should be based on repeated behavior and context.",
      content: "Trust should be based on repeated behavior and context.",
      omittedBytes: 0,
      readScopeRef: "operation-result:result:1",
    }],
    submissionSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        message: { type: "string" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  };
}

export function modelSelection() {
  return {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "low" as const,
    controls: { reasoningEffort: "low", temperature: 0 },
    controlsHash: "controls-hash",
  };
}

export function actualIdentity() {
  return {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
    controlsHash: "controls-hash",
  };
}

export function phaseContinuity() {
  return {
    objectiveState: "The phase objective is active.",
    decisions: [],
    unresolved: ["The requested operation must be observed."],
    nextOperationPurpose: "Resolve the remaining phase question.",
    publicActivity: {
      summary: "현재 단계에 필요한 내용을 확인하고 있습니다.",
      rationale: "정확한 다음 판단에 필요한 현재 상태를 확보합니다.",
      nextStep: "확인한 내용을 바탕으로 단계 결과를 작성합니다.",
    },
  };
}

export function promptRunner(
  run: (input: ProviderPhasePrompt) => Promise<ProviderPhasePromptResult>,
): ProviderPhasePromptRunner {
  return { run };
}

export function emptyContextResolver() {
  return {
    resolve(ref: string): string {
      throw new Error(`unexpected context ref: ${ref}`);
    },
  };
}

export function capabilityCatalog(
  definitions: StructuralCapabilityDefinition[],
) {
  return { list: () => definitions };
}

export function emptyCapabilityCatalog() {
  return capabilityCatalog([]);
}

export function guidanceReader(entries: AcceptedPhaseGuidance[] = []) {
  return { list: () => entries };
}

export function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
