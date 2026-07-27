import { describe, expect, test } from "bun:test";
import {
  createProductionSelectedModel,
  type ProviderPhasePrompt,
  type ProviderPhasePromptResult,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/index.ts";
import {
  actualIdentity,
  capabilityCatalog,
  emptyCapabilityCatalog,
  emptyContextResolver,
  guidanceReader,
  parseCacheOrderedPrompt,
  phaseContinuity,
  phaseEnvelope,
  promptRunner,
  publicActivity,
} from "./support/btcc-production-selected-model-fixtures.ts";

describe("production BTCC selected model", () => {
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

    const rendered = parseCacheOrderedPrompt(prompt!.prompt);
    expect(prompt?.carrierFunctions.map((item) => item.carrierKind)).toEqual([
      "phase_submission",
    ]);
    expect(JSON.stringify(prompt?.responseSchema)).not.toContain("operation_requests");
    expect(rendered.stable.promptHierarchy[0]).toEqual({
      layer: "immutablePhaseContract",
      content: expect.objectContaining({ operationSurface: "closed" }),
    });
    expect(rendered.dynamic.operationAuthority).toEqual({
      observationScopeRefs: [],
      mutation: { kind: "forbidden" },
    });
    expect(rendered.dynamic.capabilitySchemas).toEqual([]);
    expect(rendered.dynamic.availableCarrierKinds).toEqual(["phase_submission"]);
    expect(rendered.stable.carrierProtocol).toEqual({
      phaseSubmission: [
        "Use one submission object allowed by the exact phase exits.",
        "Write publicActivity as a concise user-visible handoff: name the concrete target and decision or result, why it matters to the accepted Goal, governing Spec, Plan, or review finding, and the next observable action or transition.",
        "Do not substitute a generic phase label for useful activity detail.",
        "Do not expose hidden chain-of-thought or copy raw operation output.",
      ].join(" "),
    });
  });

  test("returns a non-empty operation carrier without changing the requested model", async () => {
    const request = {
      requestId: "observe-1",
      publicTitle: "Test operation",
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
      code: "provider_protocol_interruption",
      diagnostic: {
        schema: "btcc.operational-diagnostic.v1",
        kind: "provider_carrier_rejection",
        path: "$.submission.verdict",
        reason: "missing_required",
        shape: {
          carrierType: "object",
          carrierKeys: ["kind", "submission"],
          submissionType: "object",
          submissionKeys: ["kind"],
          requestKeys: [],
        },
      },
    };

    await model.runRound(envelope);

    expect(prompt).toContain("\"providerCorrection\"");
    expect(prompt).toContain("\"provider_protocol_interruption\"");
    expect(prompt).toContain("$.submission.verdict");
    expect(prompt).toContain("missing_required");
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
            publicTitle: "Test operation",
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
      diagnostic: expect.objectContaining({
        kind: "provider_carrier_rejection",
        path: "$.requests[0].capabilityRef",
        reason: "constant_mismatch",
      }),
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
      diagnostic: expect.objectContaining({
        kind: "provider_carrier_rejection",
        path: "$.submission",
        reason: "missing_required",
      }),
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "selected_model_identity_mismatch",
      activation: { kind: "runtime_remediation" },
    });
    expect(calls).toBe(2);
  });

  test("does not automatically re-enter after a corrected carrier is rejected again", async () => {
    let calls = 0;
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async () => {
        calls += 1;
        return {
          carrier: { kind: "operation_requests", requests: [] },
          actualIdentity: actualIdentity(),
        };
      }),
    });

    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toMatchObject({
      kind: "interruption",
      code: "provider_protocol_interruption",
      activation: { kind: "automatic_provider_recovery" },
    });
    const corrected = phaseEnvelope({ emptyContext: true });
    corrected.providerCorrection = {
      kind: "previous_provider_product_rejected",
      code: "provider_protocol_interruption",
      diagnostic: {
        schema: "btcc.operational-diagnostic.v1",
        kind: "provider_carrier_rejection",
        path: "$.submission",
        reason: "missing_required",
        shape: {
          carrierType: "object",
          carrierKeys: ["kind", "requests"],
          submissionKeys: [],
          requestKeys: [],
        },
      },
    };
    expect(await model.runRound(corrected)).toMatchObject({
      kind: "interruption",
      code: "provider_protocol_interruption",
      activation: { kind: "runtime_remediation" },
    });
    expect(calls).toBe(2);
  });
});
