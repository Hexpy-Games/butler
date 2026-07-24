import { describe, expect, test } from "bun:test";
import { ModelProviderRequestError } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import {
  createProductionSelectedModel,
  type ProviderPhasePrompt,
  type ProviderPhasePromptResult,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/index.ts";
import {
  abortError,
  actualIdentity,
  capabilityCatalog,
  emptyCapabilityCatalog,
  emptyContextResolver,
  guidanceReader,
  modelSelection,
  phaseEnvelope,
  phaseContinuity,
  promptRunner,
} from "./support/btcc-production-selected-model-fixtures.ts";

const publicActivity = {
  summary: "현재 단계의 판단을 마쳤습니다.",
  rationale: "요청 목표와 단계 계약을 함께 확인했습니다.",
  nextStep: "다음 단계가 이 판단을 이어받습니다.",
};

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
    });

    const prompt = JSON.parse(calls[0]!.prompt) as Record<string, any>;
    const hierarchy = prompt.promptHierarchy;
    expect(Object.keys(hierarchy)).toEqual([
      "immutablePhaseContract",
      "versionedBasePrompt",
      "acceptedPhaseGuidance",
      "currentTurnContext",
    ]);
    expect(hierarchy.currentTurnContext.originalRequest).toEqual({
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
    expect(hierarchy.currentTurnContext.stateInput).toEqual({
      acceptedGoalRef: "goal:1",
      managedLedgerBindingRef: "ledger:1",
    });
    expect(hierarchy.currentTurnContext.operationContext).toEqual({
      phaseContinuity: null,
      latestOperationResults: [],
      priorOperationResultIndex: [expect.objectContaining({
        resultRef: { id: "result:1", sha256: "result-hash" },
        readScopeRef: "operation-result:result:1",
      })],
    });
    expect(hierarchy.currentTurnContext.operationAuthority).toEqual(phaseEnvelope().operationAuthority);
    expect(hierarchy.currentTurnContext.butlerContext).toEqual({
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
    expect(hierarchy.currentTurnContext.availableCapabilities).toEqual([{
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
    expect(JSON.stringify(calls[0]?.responseSchema)).not.toContain("workspace:write");
    const carrierSchema = calls[0]!.responseSchema as {
      anyOf: Array<{ properties: { kind: { const: string }; submission?: unknown } }>;
    };
    const submissionCarrier = carrierSchema.anyOf.find(
      (variant) => variant.properties.kind.const === "phase_submission",
    );
    expect(submissionCarrier?.properties.submission).toEqual(phaseEnvelope().submissionSchema);
    expect(hasOpenObjectSchema(calls[0]!.responseSchema)).toBe(false);
  });

  test("closes the operation carrier for Conception Opening", async () => {
    let prompt: ProviderPhasePrompt | undefined;
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: capabilityCatalog([{
        capabilityRef: "workspace:inspect",
        name: "inspect_workspace",
        description: "Inspect an authorized workspace.",
        operationKinds: ["observe"],
        observationScopeKinds: ["workspace"],
        inputSchema: { type: "object" },
      }]),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async (input) => {
        prompt = input;
        return {
          carrier: {
            kind: "phase_submission",
            submission: { kind: "opening_continuation", message: "요청을 구상해 진행하겠습니다." },
            publicActivity,
          },
          actualIdentity: actualIdentity(),
        };
      }),
    });
    const envelope = phaseEnvelope({ emptyContext: true });
    envelope.phase = "conception_opening";
    envelope.operationSurface = "closed";
    envelope.operationAuthority = {
      observationScopeRefs: ["workspace:/repo"],
      mutation: { kind: "forbidden" },
    };

    await model.runRound(envelope);

    const rendered = JSON.parse(prompt!.prompt) as {
      promptHierarchy: {
        immutablePhaseContract: { operationSurface: string };
        currentTurnContext: {
          operationAuthority: { observationScopeRefs: string[]; mutation: { kind: string } };
          availableCapabilities: unknown[];
        };
      };
      outputSchemaGuidance: {
        carrierKinds: string[];
        phaseSubmission: string;
        operationRequests?: string;
      };
    };
    expect(prompt?.carrierFunctions.map((item) => item.carrierKind)).toEqual([
      "phase_submission",
    ]);
    expect(JSON.stringify(prompt?.responseSchema)).not.toContain("operation_requests");
    expect(rendered.promptHierarchy.immutablePhaseContract.operationSurface).toBe("closed");
    expect(rendered.promptHierarchy.currentTurnContext.operationAuthority).toEqual({
      observationScopeRefs: [],
      mutation: { kind: "forbidden" },
    });
    expect(rendered.promptHierarchy.currentTurnContext.availableCapabilities).toEqual([]);
    expect(rendered.outputSchemaGuidance).toEqual({
      carrierKinds: ["phase_submission"],
      phaseSubmission: [
        "Use one submission object allowed by the exact phase exits.",
        "Write publicActivity as a concise user-visible handoff: what this phase decided, why it matters, and what the next phase will do.",
        "Do not expose hidden chain-of-thought or copy raw operation output.",
      ].join(" "),
    });
  });

  test("returns a non-empty operation carrier without changing the requested model", async () => {
    const request = {
      requestId: "observe-1",
      kind: "observe" as const,
      capabilityRef: "weather:current",
      scopeRef: "web:current",
      input: { location: "Seoul" },
    };
    let calls = 0;
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: capabilityCatalog([{
        capabilityRef: "weather:current",
        name: "current_weather",
        description: "Read current weather for one location.",
        operationKinds: ["observe"],
        observationScopeRefs: ["web:current"],
        inputSchema: { type: "object" },
      }]),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async () => {
        calls += 1;
        return {
          carrier: {
            kind: "operation_requests",
            phaseContinuity: phaseContinuity(),
            requests: [request],
          },
          actualIdentity: actualIdentity(),
        };
      }),
    });

    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "operation_requests",
      phaseContinuity: phaseContinuity(),
      requests: [request],
      actualIdentity: actualIdentity(),
    });
    expect(calls).toBe(1);
  });

  test("projects a durable provider-product rejection into the exact phase prompt", async () => {
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
    envelope.providerCorrection = {
      kind: "previous_provider_product_rejected",
      code: "provider_phase_submission_invalid",
      diagnosticMessage: "submission omitted the required verdict",
    };

    await model.runRound(envelope);

    expect(prompt).toContain("\"providerCorrection\"");
    expect(prompt).toContain("\"provider_phase_submission_invalid\"");
    expect(prompt).toContain("submission omitted the required verdict");
  });

  test("projects only the latest result body while retaining earlier durable references", async () => {
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

    const context = JSON.parse(prompt).promptHierarchy.currentTurnContext.operationContext;
    expect(context.phaseContinuity).toEqual(phaseContinuity());
    expect(context.latestOperationResults).toEqual([latest]);
    expect(context.priorOperationResultIndex).toHaveLength(1);
    expect(context.priorOperationResultIndex[0]).not.toHaveProperty("preview");
    expect(context.priorOperationResultIndex[0].resultRef).toEqual({
      id: "result:1",
      sha256: "result-hash",
    });
  });

  test("rejects an operation that was not offered by the exact phase capability schema", async () => {
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: capabilityCatalog([{
        capabilityRef: "workspace:read",
        name: "read_file",
        description: "Read one workspace file.",
        operationKinds: ["review_validation"],
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      }]),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async () => ({
        carrier: {
          kind: "operation_requests",
          phaseContinuity: phaseContinuity(),
          requests: [{
            requestId: "invalid-review-operation",
            kind: "review_validation",
            capabilityRef: "project_ledger_read",
            input: { record_ids: ["SPEC-1"] },
          }],
        },
        actualIdentity: actualIdentity(),
      })),
    });

    const envelope = phaseEnvelope({ emptyContext: true });
    envelope.operationAuthority = {
      observationScopeRefs: [],
      mutation: {
        kind: "validation_overlay_only",
        reviewSourceRef: { id: "review-source", sha256: "review-source-sha" },
      },
    };
    expect(await model.runRound(envelope)).toEqual({
      kind: "interruption",
      code: "provider_protocol_interruption",
      activation: { kind: "automatic_provider_recovery" },
      diagnosticMessage: "BTCC provider carrier violates the rendered schema at $.submission",
    });
  });

  test("rejects malformed output and identity mismatch without retry or fallback", async () => {
    let calls = 0;
    const responses: ProviderPhasePromptResult[] = [
      { carrier: { kind: "operation_requests", requests: [] }, actualIdentity: actualIdentity() },
      {
        carrier: { kind: "phase_submission", submission: { kind: "plan" }, publicActivity },
        actualIdentity: { ...actualIdentity(), model: "gpt-5.5" },
      },
    ];
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async () => responses[calls++]!),
    });

    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_protocol_interruption",
      activation: { kind: "automatic_provider_recovery" },
      diagnosticMessage: "BTCC provider carrier violates the rendered schema at $.submission",
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "selected_model_identity_mismatch",
      activation: { kind: "runtime_remediation" },
    });
    expect(calls).toBe(2);
  });

  test("maps abort, transport, 429, and 5xx to operational recovery", async () => {
    const failures = [abortError(), new ModelProviderRequestError({
      code: "provider_transport_interruption",
      message: "network unavailable",
      provider: "openai",
      api: "responses",
      retryable: true,
    }), new ModelProviderRequestError({
      code: "provider_rate_limited",
      message: "rate limited",
      provider: "openai",
      api: "responses",
      statusCode: 429,
      retryable: true,
    }), new ModelProviderRequestError({
      code: "provider_api_error",
      message: "service unavailable",
      provider: "zai",
      api: "chat_completions",
      statusCode: 502,
      retryable: true,
    })];
    let calls = 0;
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async () => {
        const failure = failures[calls++];
        throw failure;
      }),
    });

    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_aborted",
      activation: { kind: "cancelled" },
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_transport_interruption",
      activation: { kind: "automatic_provider_recovery" },
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_rate_limited",
      activation: { kind: "automatic_provider_recovery" },
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_api_error",
      activation: { kind: "automatic_provider_recovery" },
    });
    expect(calls).toBe(4);

    const controller = new AbortController();
    controller.abort();
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }), controller.signal)).toEqual({
      kind: "interruption",
      code: "provider_aborted",
      activation: { kind: "cancelled" },
    });
    expect(calls).toBe(4);
  });

  test("bounds the whole selected-model round before provider admission", async () => {
    let promptCalls = 0;
    const model = createProductionSelectedModel({
      context: {
        resolve: async () => await new Promise<string>(() => {}),
      },
      capabilities: emptyCapabilityCatalog(),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async () => {
        promptCalls += 1;
        throw new Error("provider must not be reached");
      }),
      roundBoundary: { totalTimeoutMs: 20 },
    });
    const envelope = phaseEnvelope();

    expect(await model.runRound(envelope)).toEqual({
      kind: "interruption",
      code: "provider_round_timeout",
      activation: { kind: "automatic_provider_recovery" },
    });
    expect(promptCalls).toBe(0);
  });

  test("the selected-model round boundary aborts an admitted provider call", async () => {
    let roundSignal: AbortSignal | undefined;
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async (input) => {
        roundSignal = input.signal;
        return await new Promise<ProviderPhasePromptResult>(() => {});
      }),
      roundBoundary: { totalTimeoutMs: 20 },
    });

    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_round_timeout",
      activation: { kind: "automatic_provider_recovery" },
    });
    expect(roundSignal?.aborted).toBe(true);
  });

  test("holds provider action and protocol defects without automatic replay", async () => {
    const failures = [
      new ModelProviderRequestError({
        code: "provider_auth_error",
        message: "credentials rejected",
        provider: "zai",
        api: "chat_completions",
        statusCode: 401,
        retryable: false,
      }),
      new ModelProviderRequestError({
        code: "provider_empty_response",
        message: "carrier missing",
        provider: "zai",
        api: "chat_completions",
        retryable: true,
      }),
    ];
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async () => { throw failures.shift()!; }),
    });

    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_auth_error",
      activation: { kind: "provider_action_required" },
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_empty_response",
      activation: { kind: "automatic_provider_recovery" },
    });
  });
});

function hasOpenObjectSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "object" && record.additionalProperties === true) return true;
  return Object.values(record).some(hasOpenObjectSchema);
}
