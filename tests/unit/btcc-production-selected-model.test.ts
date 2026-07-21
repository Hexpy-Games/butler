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
  modelSelection,
  phaseEnvelope,
  promptRunner,
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
      promptRunner: runner,
    });
    const signal = new AbortController().signal;

    const result = await model.runRound(phaseEnvelope(), signal);

    expect(result).toEqual({
      kind: "phase_submission",
      submission: { kind: "opening_continuation", message: "I am checking the request." },
      actualIdentity: actualIdentity(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelSelection).toEqual(modelSelection());
    expect(calls[0]?.signal).toBe(signal);
    expect(calls[0]?.cacheScope).toBe("btcc:planning");
    expect(calls[0]?.responseSchema).toMatchObject({ type: "object" });
    expect(calls[0]?.carrierFunctions.map((entry) => entry.carrierKind)).toEqual([
      "phase_submission",
      "operation_requests",
    ]);
    expect(calls[0]?.carrierFunctions[0]?.parameters).toMatchObject({
      required: ["submission"],
      additionalProperties: false,
    });

    const prompt = JSON.parse(calls[0]!.prompt) as Record<string, any>;
    expect(prompt.originalRequest).toEqual({
      messageId: "message-1",
      content: "Improve Sandy's trust profiling without changing her voice.",
    });
    expect(prompt.phaseContract).toEqual({
      phase: "planning",
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
    });
    expect(prompt.stateInput).toEqual({
      acceptedGoalRef: "goal:1",
      managedLedgerBindingRef: "ledger:1",
    });
    expect(prompt.priorOperationResults).toEqual(phaseEnvelope().operationResults);
    expect(prompt.operationAuthority).toEqual(phaseEnvelope().operationAuthority);
    expect(prompt.butlerContext).toEqual({
      sessionId: "session-1",
      userRef: "user-1",
      projectRef: "project-1",
      profile: [{ ref: "profile:1", content: resolved.get("profile:1") }],
      recentFeedback: [{ ref: "feedback:1", content: resolved.get("feedback:1") }],
      mandatoryHotCache: [{ ref: "hot:mandatory", content: resolved.get("hot:mandatory") }],
      optionalHotCache: [{ ref: "hot:optional", content: resolved.get("hot:optional") }],
      continuationCandidates: [],
      baselineObservationScopeRefs: ["web:current"],
    });
    expect(prompt.availableCapabilities).toEqual([{
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
      promptRunner: promptRunner(async () => {
        calls += 1;
        return {
          carrier: { kind: "operation_requests", requests: [request] },
          actualIdentity: actualIdentity(),
        };
      }),
    });

    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "operation_requests",
      requests: [request],
      actualIdentity: actualIdentity(),
    });
    expect(calls).toBe(1);
  });

  test("rejects malformed output and identity mismatch without retry or fallback", async () => {
    let calls = 0;
    const responses: ProviderPhasePromptResult[] = [
      { carrier: { kind: "operation_requests", requests: [] }, actualIdentity: actualIdentity() },
      {
        carrier: { kind: "phase_submission", submission: { kind: "plan" } },
        actualIdentity: { ...actualIdentity(), model: "gpt-5.5" },
      },
    ];
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      promptRunner: promptRunner(async () => responses[calls++]!),
    });

    await expect(model.runRound(phaseEnvelope({ emptyContext: true }))).rejects.toThrow(
      "BTCC provider carrier violates the closed protocol",
    );
    await expect(model.runRound(phaseEnvelope({ emptyContext: true }))).rejects.toThrow(
      "BTCC provider returned a different selected-model identity",
    );
    expect(calls).toBe(2);
  });

  test("maps abort and network failures to operational interruptions with one call", async () => {
    const failures = [abortError(), new ModelProviderRequestError({
      code: "provider_transport_interruption",
      message: "network unavailable",
      provider: "openai",
      api: "responses",
      retryable: true,
    })];
    let calls = 0;
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      promptRunner: promptRunner(async () => {
        const failure = failures[calls++];
        throw failure;
      }),
    });

    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_aborted",
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_transport_interruption",
    });
    expect(calls).toBe(2);

    const controller = new AbortController();
    controller.abort();
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }), controller.signal)).toEqual({
      kind: "interruption",
      code: "provider_aborted",
    });
    expect(calls).toBe(2);
  });
});

function hasOpenObjectSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "object" && record.additionalProperties === true) return true;
  return Object.values(record).some(hasOpenObjectSchema);
}
