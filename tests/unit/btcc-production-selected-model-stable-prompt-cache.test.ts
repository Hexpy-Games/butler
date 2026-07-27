import { describe, expect, test } from "bun:test";
import {
  createProductionSelectedModel,
  type ProviderPhasePrompt,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/index.ts";
import {
  actualIdentity,
  capabilityCatalog,
  emptyContextResolver,
  guidanceReader,
  parseCacheOrderedPrompt,
  phaseEnvelope,
  promptRunner,
  publicActivity,
} from "./support/btcc-production-selected-model-fixtures.ts";

describe("production BTCC selected model", () => {
  test("keeps one serialized stable prefix while dynamic Turn state changes", async () => {
    const calls: ProviderPhasePrompt[] = [];
    const capabilities = [
      {
        capabilityRef: "web:search",
        name: "search_web",
        description: "Search the authorized web scope.",
        operationKinds: ["observe" as const],
        observationScopeRefs: ["web:current"],
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        capabilityRef: "web:read",
        name: "read_web_page",
        description: "Read one page in the authorized web scope.",
        operationKinds: ["observe" as const],
        observationScopeRefs: ["web:current"],
        inputSchema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
          additionalProperties: false,
        },
      },
    ];
    const createModel = (reverse: boolean) => createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: capabilityCatalog(reverse ? [...capabilities].reverse() : capabilities),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async (input) => {
        calls.push(input);
        return {
          carrier: { kind: "phase_submission", submission: { kind: "plan" }, publicActivity },
          actualIdentity: actualIdentity(),
        };
      }),
    });
    const firstEnvelope = phaseEnvelope({ emptyContext: true });
    const secondEnvelope = phaseEnvelope({ emptyContext: true });
    secondEnvelope.binding = {
      ...secondEnvelope.binding,
      turnId: "turn-2",
      turnRevision: 9,
      checkpointId: "checkpoint-2",
      checkpointRevision: 6,
    };
    secondEnvelope.context = {
      ...secondEnvelope.context,
      originalMessageId: "message-2",
      originalMessage: "A different current request.",
      stateInput: {
        acceptedGoalRef: "goal:2",
        currentTimestamp: "2026-07-27T12:34:56.000Z",
      },
    };
    secondEnvelope.authoringContractRefs = ["spec-authoring@2"];
    secondEnvelope.authoringContracts = [{
      contractId: "spec-authoring",
      revisionRef: { id: "spec-authoring@2", sha256: "authoring-hash-2" },
      applicableRules: ["preserve-current-behavior"],
    }];
    secondEnvelope.operationResults = [{
      ...secondEnvelope.operationResults[0]!,
      resultRef: { id: "result:2", sha256: "result-hash-2" },
      requestRef: { id: "request:2", sha256: "request-hash-2" },
      preview: "different complete result",
      content: "different complete result",
      readScopeRef: "operation-result:result:2",
    }];

    await createModel(false).runRound(firstEnvelope);
    await createModel(true).runRound(secondEnvelope);

    const first = parseCacheOrderedPrompt(calls[0]!.prompt);
    const second = parseCacheOrderedPrompt(calls[1]!.prompt);
    expect(first.serializedStablePrefix).toBe(second.serializedStablePrefix);
    expect(first.dynamic).not.toEqual(second.dynamic);
    expect(calls[0]!.instructions).toBe(calls[1]!.instructions);
    expect(calls[0]!.responseSchema).toEqual(calls[1]!.responseSchema);
    expect(calls[0]!.carrierFunctions).toEqual(calls[1]!.carrierFunctions);
    expect(calls[0]!.cacheScope).toBe(calls[1]!.cacheScope);
    expect(calls[0]!.promptCacheBoundary.stablePrefix)
      .toBe(first.serializedStablePrefix + "\n");
    expect(calls[0]!.promptCacheBoundary.stablePrefix)
      .toBe(calls[1]!.promptCacheBoundary.stablePrefix);
    expect(calls[0]!.promptCacheBoundary.dynamicSuffix)
      .not.toBe(calls[1]!.promptCacheBoundary.dynamicSuffix);
    expect(
      calls[0]!.promptCacheBoundary.stablePrefix +
      calls[0]!.promptCacheBoundary.dynamicSuffix,
    ).toBe(calls[0]!.prompt);
    expect(first.serializedStablePrefix).not.toContain("web:read");
    expect(first.serializedStablePrefix).toContain("carrierProtocol");
    expect(first.dynamic.capabilitySchemas).toHaveLength(2);
    expect(first.dynamic.availableCarrierKinds)
      .toEqual(["phase_submission", "operation_requests"]);
    expect(first.serializedStablePrefix).not.toContain("turn-1");
    expect(first.serializedStablePrefix).not.toContain("message-1");
    expect(first.serializedStablePrefix).not.toContain("result:1");
    expect(calls[0]!.prompt.slice(first.serializedStablePrefix.length + 1)).toContain("turn-1");
    expect(calls[1]!.prompt.slice(second.serializedStablePrefix.length + 1)).toContain("turn-2");
  });
});
