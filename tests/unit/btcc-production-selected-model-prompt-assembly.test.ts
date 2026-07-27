import { describe, expect, test } from "bun:test";
import {
  createProductionSelectedModel,
  type ProviderPhasePrompt,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/index.ts";
import {
  actualIdentity,
  capabilityCatalog,
  emptyCapabilityCatalog,
  emptyContextResolver,
  guidanceReader,
  modelSelection,
  parseCacheOrderedPrompt,
  phaseEnvelope,
  phaseContinuity,
  promptRunner,
  publicActivity,
} from "./support/btcc-production-selected-model-fixtures.ts";

describe("production BTCC selected model", () => {
  test("sends the exact identity, phase state, operations, authority, and resolved context once", async () => {
    const calls: ProviderPhasePrompt[] = [];
    const resolved = new Map([
      ["profile:1", "Prefers concise technical explanations."],
      ["feedback:1", "Do not hide the active model identity."],
      ["hot:mandatory", "Use ssh -i ~/.ssh/test_key test@192.0.2.1."],
      ["hot:optional", "A prior answer used a table."],
    ]);
    const runner = promptRunner(async (input) => {
      calls.push(input);
      return {
        carrier: {
          kind: "phase_submission",
          submission: { kind: "opening_continuation", message: "I am checking the request." },
          publicActivity,
        },
        actualIdentity: actualIdentity(),
      };
    });
    const model = createProductionSelectedModel({
      context: {
        resolve(ref) {
          const content = resolved.get(ref);
          if (!content) throw new Error(`missing context: ${ref}`);
          return content;
        },
      },
      capabilities: capabilityCatalog([
        {
          capabilityRef: "weather:current",
          name: "current_weather",
          description: "Read current weather for one location.",
          operationKinds: ["observe"],
          observationScopeRefs: ["web:current", "web:forecast"],
          inputSchema: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
            additionalProperties: false,
          },
        },
        {
          capabilityRef: "workspace:write",
          name: "write_workspace_file",
          description: "Write one file in an authorized workspace.",
          operationKinds: ["workspace_artifact_action"],
          inputSchema: { type: "object" },
        },
      ]),
      guidance: guidanceReader([{
        guidanceId: "planning-check-original-goal",
        phase: "planning",
        scope: { kind: "project", projectRef: "project-1" },
        scopeRationale: "The guidance is specific to project-1.",
        scopeSourceRefs: ["source-1"],
        generalityBoundary: "project_bound_strategy",
        revisionKind: "merge",
        predecessor: {
          guidanceId: "planning-check-original-goal",
          phase: "planning",
          scope: { kind: "project", projectRef: "project-1" },
          revision: 1,
          contentSha256: "guidance-hash-v1",
        },
        revision: 2,
        guidance: "Trace every Task to the immutable original goal.",
        appliesWhen: ["managed project work"],
        doesNotApplyWhen: ["direct answer"],
        sourceIds: ["source-1"],
        contentSha256: "guidance-hash",
      }]),
      promptRunner: runner,
    });
    const signal = new AbortController().signal;

    const result = await model.runRound(phaseEnvelope(), signal);

    expect(result).toEqual({
      kind: "phase_submission",
      submission: { kind: "opening_continuation", message: "I am checking the request." },
      publicActivity,
      actualIdentity: actualIdentity(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelSelection).toEqual(modelSelection());
    expect(calls[0]?.signal).not.toBe(signal);
    expect(calls[0]?.signal?.aborted).toBe(false);
    expect(calls[0]?.cacheScope).toBe("btcc:planning");
    expect(calls[0]?.usageAttribution).toEqual({
      turnId: "turn-1",
      phase: "planning",
    });
    expect(calls[0]?.responseSchema).toMatchObject({
      anyOf: [
        {
          type: "object",
          properties: { kind: { const: "phase_submission" } },
        },
        {
          type: "object",
          properties: { kind: { const: "operation_requests" } },
        },
      ],
    });
    expect(calls[0]?.carrierFunctions.map((entry) => entry.carrierKind)).toEqual([
      "phase_submission",
      "operation_requests",
    ]);
    expect(calls[0]?.carrierFunctions[0]?.parameters).toMatchObject({
      required: ["submission", "publicActivity"],
      additionalProperties: false,
      properties: {
        submission: phaseEnvelope().submissionSchema,
      },
    });

    const { stable, dynamic } = parseCacheOrderedPrompt(calls[0]!.prompt);
    const hierarchy = Object.fromEntries(
      stable.promptHierarchy.map((layer: Record<string, any>) => [layer.layer, layer.content]),
    );
    expect(stable.carrierProtocol.operationRequests)
      .toContain("every currently known independent operation");
    expect(stable.carrierProtocol.operationRequests)
      .toContain("executionSummary");
    expect(stable.promptHierarchy.map((layer: Record<string, any>) => layer.layer)).toEqual([
      "immutablePhaseContract",
      "versionedBasePrompt",
      "acceptedPhaseGuidance",
    ]);
    expect(dynamic.originalRequest).toEqual({
      messageId: "message-1",
      content: "Improve Sandy's trust profiling without changing her voice.",
    });
    expect(hierarchy.immutablePhaseContract).toMatchObject({
      phase: "planning",
      objective: "Author the smallest sufficient plan.",
      duties: [
        {
          id: "preserve_original_goal",
          instruction: expect.stringContaining("immutable GoalContract"),
        },
        {
          id: "author_smallest_sufficient_plan",
          instruction: expect.stringContaining("fewest cohesive Works"),
        },
      ],
      prohibitions: [
        {
          id: "no_model_substitution",
          instruction: expect.stringContaining("switch models"),
        },
        {
          id: "no_hidden_retry_loop",
          instruction: expect.stringContaining("unchanged semantic output"),
        },
      ],
      exitDuties: {
        PlanCandidate: [{
          id: "declare_verification_integration",
          instruction: expect.stringContaining("ResultCandidate"),
        }],
      },
    });
    expect(dynamic.currentAcceptedState).toEqual({
      stateInput: {
        acceptedGoalRef: "goal:1",
        managedLedgerBindingRef: "ledger:1",
      },
      authoringContractRefs: ["spec-authoring@1"],
      authoringContracts: [{
        contractId: "spec-authoring",
        revisionRef: { id: "spec-authoring@1", sha256: "authoring-hash" },
        applicableRules: ["one-concern-per-spec"],
      }],
    });
    expect(hierarchy.versionedBasePrompt).toMatchObject({
      revision: "btcc.base-prompt.v2",
    });
    expect(hierarchy.acceptedPhaseGuidance).toEqual([{
      guidanceId: "planning-check-original-goal",
      phase: "planning",
      scope: { kind: "project", projectRef: "project-1" },
      scopeRationale: "The guidance is specific to project-1.",
      scopeSourceRefs: ["source-1"],
      generalityBoundary: "project_bound_strategy",
      revisionKind: "merge",
      predecessor: {
        guidanceId: "planning-check-original-goal",
        phase: "planning",
        scope: { kind: "project", projectRef: "project-1" },
        revision: 1,
        contentSha256: "guidance-hash-v1",
      },
      revision: 2,
      guidance: "Trace every Task to the immutable original goal.",
      appliesWhen: ["managed project work"],
      doesNotApplyWhen: ["direct answer"],
      sourceIds: ["source-1"],
      contentSha256: "guidance-hash",
    }]);
    expect(dynamic.operationContext).toEqual({
      phaseContinuity: null,
      inlineOperationResults: [expect.objectContaining({
        resultRef: { id: "result:1", sha256: "result-hash" },
        inlinePayload: {
          kind: "complete",
          content: "Trust should be based on repeated behavior and context.",
        },
      })],
      selectedOperationResultViews: [],
      priorOperationResultIndex: [],
    });
    expect(dynamic.operationAuthority).toEqual(phaseEnvelope().operationAuthority);
    expect(dynamic.butlerContext).toEqual({
      sessionId: "session-1",
      userRef: "user-1",
      projectRef: "project-1",
      profile: [{ ref: "profile:1", content: resolved.get("profile:1") }],
      recentFeedback: [{ ref: "feedback:1", content: resolved.get("feedback:1") }],
      mandatoryHotCache: [{ ref: "hot:mandatory", content: resolved.get("hot:mandatory") }],
      optionalHotCache: [{ ref: "hot:optional", content: resolved.get("hot:optional") }],
      continuation: { candidates: [] },
      baselineObservationScopeRefs: ["web:current"],
    });
    expect(dynamic.capabilitySchemas).toEqual([{
      capabilityRef: "weather:current",
      name: "current_weather",
      description: "Read current weather for one location.",
      operationKind: "observe",
      observationScopeRefs: ["web:current"],
      inputSchema: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
        additionalProperties: false,
      },
    }]);
    expect(JSON.stringify(calls[0]?.responseSchema)).toContain("weather:current");
    expect(JSON.stringify(calls[0]?.responseSchema)).toContain("workspace:write");
    const carrierSchema = calls[0]!.responseSchema as {
      anyOf: Array<{ properties: { kind: { const: string }; submission?: unknown } }>;
    };
    const submissionCarrier = carrierSchema.anyOf.find(
      (variant) => variant.properties.kind.const === "phase_submission",
    );
    expect(submissionCarrier?.properties.submission).toEqual(phaseEnvelope().submissionSchema);
    expect(hasOpenObjectSchema(calls[0]!.responseSchema)).toBe(false);
  });

  test("projects the latest result body while retaining earlier durable references", async () => {
    let prompt = "";
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async (input) => {
        prompt = input.prompt;
        return {
          carrier: { kind: "phase_submission", submission: { kind: "plan" }, publicActivity },
          actualIdentity: actualIdentity(),
        };
      }),
    });
    const envelope = phaseEnvelope({ emptyContext: true });
    const latest = {
      ...envelope.operationResults[0]!,
      requestId: "latest-observation",
      resultRef: { id: "result:2", sha256: "result-hash-2" },
      requestRef: { id: "request:2", sha256: "request-hash-2" },
      preview: "latest full result",
      content: "latest full result",
      readScopeRef: "operation-result:result:2",
    };
    envelope.operationResults.push(latest);
    envelope.latestOperationResultCount = 1;
    envelope.phaseContinuity = phaseContinuity();

    await model.runRound(envelope);

    const context = parseCacheOrderedPrompt(prompt).dynamic.operationContext;
    expect(context.phaseContinuity).toEqual(phaseContinuity());
    expect(context.inlineOperationResults).toHaveLength(2);
    expect(context.inlineOperationResults[1]).toMatchObject({
      resultRef: latest.resultRef,
      inlinePayload: { kind: "complete", content: "latest full result" },
    });
    expect(context.selectedOperationResultViews).toEqual([]);
    expect(context.priorOperationResultIndex).toEqual([]);
  });
});

function hasOpenObjectSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "object" && record.additionalProperties === true) return true;
  return Object.values(record).some(hasOpenObjectSchema);
}
