import { describe, expect, test } from "bun:test";
import {
  createProductionSelectedModel,
  type ProviderPhasePrompt,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/index.ts";
import { estimateTokensForModel } from
  "../../packages/butler-agent/src/integrations/providers/model-catalog.ts";
import {
  actualIdentity,
  capabilityCatalog,
  emptyContextResolver,
  guidanceReader,
  phaseEnvelope,
  promptRunner,
} from "./support/btcc-production-selected-model-fixtures.ts";

const publicActivity = {
  title: "단계 판단 완료",
  summary: "현재 단계의 판단을 마쳤습니다.",
  rationale: "요청 목표와 단계 계약을 함께 확인했습니다.",
  nextStep: "다음 단계가 이 판단을 이어받습니다.",
};

describe("BTCC phase prompt cache boundary", () => {
  test("keeps exact availability dynamic while the provider surface stays stable", async () => {
    const calls: ProviderPhasePrompt[] = [];
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: capabilityCatalog([
        {
          capabilityRef: "result:read",
          name: "read_operation_result",
          description: "Read an authorized durable operation result.",
          operationKinds: ["observe"],
          observationScopeKinds: ["result"],
          inputSchema: closedObjectSchema({ resultRef: { type: "string" } }, ["resultRef"]),
        },
      ]),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async (input) => {
        calls.push(input);
        return {
          carrier: { kind: "phase_submission", submission: { kind: "plan" }, publicActivity },
          actualIdentity: actualIdentity(),
        };
      }),
    });
    const first = phaseEnvelope({ emptyContext: true });
    const second = phaseEnvelope({ emptyContext: true });
    second.binding = {
      ...second.binding,
      turnId: "turn-2",
      turnRevision: 1,
      checkpointId: "checkpoint-2",
      checkpointRevision: 1,
    };
    second.operationAuthority = {
      ...second.operationAuthority,
      observationScopeRefs: ["web:current", "result:result-1"],
    };

    expect(await model.runRound(first)).toMatchObject({ kind: "phase_submission" });
    expect(await model.runRound(second)).toMatchObject({ kind: "phase_submission" });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.promptCacheBoundary.stablePrefix)
      .toBe(calls[1]!.promptCacheBoundary.stablePrefix);
    const firstDynamic = dynamicDocument(calls[0]!);
    const secondDynamic = dynamicDocument(calls[1]!);
    expect(capabilityRefs(firstDynamic)).toEqual([]);
    expect(capabilityRefs(secondDynamic)).toEqual(["result:read"]);
    expect(firstDynamic.availableCarrierKinds)
      .toEqual(["phase_submission"]);
    expect(secondDynamic.availableCarrierKinds)
      .toEqual(["phase_submission", "operation_requests"]);
    expect(calls[0]!.promptCacheBoundary.dynamicSuffix)
      .not.toBe(calls[1]!.promptCacheBoundary.dynamicSuffix);
    expect(calls[0]!.responseSchema).toEqual(calls[1]!.responseSchema);
    expect(calls[0]!.carrierFunctions).toEqual(calls[1]!.carrierFunctions);
    expect(JSON.stringify(calls[0]!.responseSchema)).toContain("result:read");
    expect(JSON.stringify(calls[1]!.responseSchema)).toContain("result:read");
    expect(stableProviderSurface(calls[0]!)).toBe(stableProviderSurface(calls[1]!));
    assertExactPrompt(calls[0]!);
    assertExactPrompt(calls[1]!);
  });

  test("rejects unavailable result reads before binding and admits only the exact current scope", async () => {
    const calls: ProviderPhasePrompt[] = [];
    const scopes = ["result:result-1", "result:result-1", "result:wrong"];
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: capabilityCatalog([resultReadCapability()]),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async (input) => {
        calls.push(input);
        return {
          carrier: resultReadCarrier(scopes[calls.length - 1]!),
          actualIdentity: actualIdentity(),
        };
      }),
    });
    const beforeResult = phaseEnvelope({ emptyContext: true });
    const afterResult = phaseEnvelope({ emptyContext: true });
    afterResult.operationAuthority = {
      ...afterResult.operationAuthority,
      observationScopeRefs: ["web:current", "result:result-1"],
    };

    expect(await model.runRound(beforeResult)).toMatchObject({
      kind: "interruption",
      code: "provider_protocol_interruption",
    });
    expect(await model.runRound(afterResult)).toMatchObject({
      kind: "operation_requests",
      requests: [expect.objectContaining({
        capabilityRef: "result:read",
        scopeRef: "result:result-1",
      })],
    });
    expect(await model.runRound(afterResult)).toMatchObject({
      kind: "interruption",
      code: "provider_protocol_interruption",
    });
    expect(calls[0]!.responseSchema).toEqual(calls[1]!.responseSchema);
    expect(calls[1]!.responseSchema).toEqual(calls[2]!.responseSchema);
  });

  test("changes the stable prefix when the immutable phase contract changes", async () => {
    const calls: ProviderPhasePrompt[] = [];
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: capabilityCatalog([]),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async (input) => {
        calls.push(input);
        return {
          carrier: { kind: "phase_submission", submission: { kind: "plan" }, publicActivity },
          actualIdentity: actualIdentity(),
        };
      }),
    });
    const original = taskExecutionEnvelope();
    const revised = {
      ...original,
      objective: "Execute a revised, still immutable phase objective.",
    };

    await model.runRound(original);
    await model.runRound(revised);

    expect(calls[0]!.promptCacheBoundary.stablePrefix)
      .not.toBe(calls[1]!.promptCacheBoundary.stablePrefix);
    expect(calls[1]!.promptCacheBoundary.stablePrefix)
      .toContain("Execute a revised, still immutable phase objective.");
    const stableEstimate = estimateTokensForModel(
      calls[0]!.promptCacheBoundary.stablePrefix,
      "openai/gpt-5.6-sol",
    );
    expect(stableEstimate.source).toBe("openai_tiktoken_o200k");
    expect(stableEstimate.tokens).toBeGreaterThanOrEqual(1_024);
    assertExactPrompt(calls[0]!);
    assertExactPrompt(calls[1]!);
  });
});

type DynamicPromptDocument = {
  capabilitySchemas: Array<{ capabilityRef: string }>;
  availableCarrierKinds: string[];
};

function dynamicDocument(call: ProviderPhasePrompt): DynamicPromptDocument {
  return (JSON.parse(call.promptCacheBoundary.dynamicSuffix) as {
    dynamicTurnContent: DynamicPromptDocument;
  }).dynamicTurnContent;
}

function capabilityRefs(document: DynamicPromptDocument): string[] {
  return document.capabilitySchemas.map(
    (capability) => capability.capabilityRef,
  );
}

function assertExactPrompt(call: ProviderPhasePrompt): void {
  expect(call.promptCacheBoundary.stablePrefix + call.promptCacheBoundary.dynamicSuffix)
    .toBe(call.prompt);
}

function closedObjectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function resultReadCapability() {
  return {
    capabilityRef: "result:read",
    name: "read_operation_result",
    description: "Read an authorized durable operation result.",
    operationKinds: ["observe" as const],
    observationScopeKinds: ["result" as const],
    inputSchema: closedObjectSchema({ resultRef: { type: "string" } }, ["resultRef"]),
  };
}

function resultReadCarrier(scopeRef: string) {
  return {
    kind: "operation_requests",
    phaseContinuity: {
      objectiveState: "The durable result is needed.",
      decisions: [],
      unresolved: ["The exact result content is not loaded."],
      nextOperationPurpose: "Read the exact admitted result.",
      publicActivity,
    },
    requests: [{
      requestId: "read-result-1",
      publicTitle: "Read the exact operation result",
      kind: "observe",
      capabilityRef: "result:read",
      scopeRef,
      input: { resultRef: "result-1" },
    }],
  };
}

function stableProviderSurface(call: ProviderPhasePrompt): string {
  return JSON.stringify({
    instructions: call.instructions,
    stablePrefix: call.promptCacheBoundary.stablePrefix,
    responseSchema: call.responseSchema,
    carrierFunctions: call.carrierFunctions,
  });
}

function taskExecutionEnvelope() {
  const envelope = phaseEnvelope({ emptyContext: true });
  envelope.phase = "task_execution";
  envelope.objective = "execute_the_exact_accepted_task_and_record_its_concrete_result";
  envelope.duties = [
    "preserve_original_goal",
    "preserve_selected_model",
    "state_input_only",
    "execute_accepted_task",
    "record_concrete_result",
    "author_managed_deferral",
  ];
  envelope.prohibitions = [
    "no_successor_choice",
    "no_runtime_semantic_judgment",
    "no_model_substitution",
    "no_heuristic_route",
    "no_generic_assurance_layer",
    "no_hidden_retry_loop",
    "no_self_review",
  ];
  delete envelope.exitDuties;
  return envelope;
}
