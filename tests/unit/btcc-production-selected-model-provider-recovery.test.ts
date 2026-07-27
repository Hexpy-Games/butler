import { describe, expect, test } from "bun:test";
import { ModelProviderRequestError } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import {
  createProductionSelectedModel,
  type ProviderPhasePromptResult,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/index.ts";
import type { OperationalDiagnostic } from
  "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";
import {
  abortError,
  emptyCapabilityCatalog,
  emptyContextResolver,
  guidanceReader,
  phaseEnvelope,
  promptRunner,
} from "./support/btcc-production-selected-model-fixtures.ts";

describe("production BTCC selected model", () => {
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
      diagnostic: providerDiagnostic("openai", "responses", true),
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_rate_limited",
      activation: { kind: "provider_action_required" },
      diagnostic: providerDiagnostic("openai", "responses", true, {
        statusCode: 429,
      }),
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_api_error",
      activation: { kind: "automatic_provider_recovery" },
      diagnostic: providerDiagnostic("zai", "chat_completions", true, {
        statusCode: 502,
      }),
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

  test("carries provider-declared readiness into automatic HTTP recovery", async () => {
    const retryAt = "2026-07-27T06:00:00.000Z";
    const failures = [
      new ModelProviderRequestError({
        code: "provider_rate_limited",
        message: "rate limited",
        provider: "zai",
        api: "chat_completions",
        statusCode: 429,
        retryable: true,
        retryAt,
      }),
      new ModelProviderRequestError({
        code: "provider_api_error",
        message: "service unavailable",
        provider: "zai",
        api: "chat_completions",
        statusCode: 503,
        retryable: true,
        retryAt,
      }),
    ];
    let calls = 0;
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async () => {
        throw failures[calls++];
      }),
    });

    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_rate_limited",
      activation: { kind: "automatic_provider_recovery", retryAt },
      diagnostic: providerDiagnostic("zai", "chat_completions", true, {
        statusCode: 429,
        retryAt,
      }),
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_api_error",
      activation: { kind: "automatic_provider_recovery", retryAt },
      diagnostic: providerDiagnostic("zai", "chat_completions", true, {
        statusCode: 503,
        retryAt,
      }),
    });
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
      diagnostic: providerDiagnostic("zai", "chat_completions", false, {
        statusCode: 401,
      }),
    });
    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_empty_response",
      activation: { kind: "automatic_provider_recovery" },
      diagnostic: providerDiagnostic("zai", "chat_completions", true),
    });
  });

  test("classifies provider-reported context overflow as internal prompt remediation", async () => {
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async () => {
        throw new ModelProviderRequestError({
          code: "provider_context_limit_exceeded",
          message: "assembled request exceeded model context",
          provider: "openai",
          api: "responses",
          statusCode: 400,
          retryable: false,
        });
      }),
    });

    expect(await model.runRound(phaseEnvelope({ emptyContext: true }))).toEqual({
      kind: "interruption",
      code: "provider_context_limit_exceeded",
      activation: { kind: "runtime_remediation" },
      diagnostic: providerDiagnostic("openai", "responses", false, {
        statusCode: 400,
      }),
    });
  });

  test("rejects an oversized locally assembled prompt before provider transport", async () => {
    let calls = 0;
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      guidance: guidanceReader(),
      promptRunner: promptRunner(async () => {
        calls += 1;
        throw new Error("provider transport must not run");
      }),
    });
    const envelope = phaseEnvelope({ emptyContext: true });
    envelope.modelSelection = {
      ...envelope.modelSelection,
      contextWindowTokens: 128_100,
    };
    envelope.context.stateInput = { oversized: "x" };

    expect(await model.runRound(envelope)).toMatchObject({
      kind: "interruption",
      code: "phase_prompt_capacity_exceeded",
      activation: { kind: "runtime_remediation" },
      diagnosticMessage: expect.stringContaining("input tokens"),
    });
    expect(calls).toBe(0);
  });
});

function providerDiagnostic(
  provider: string,
  api: string,
  retryable: boolean,
  details: Partial<OperationalDiagnostic> = {},
): OperationalDiagnostic {
  return {
    schema: "btcc.operational-diagnostic.v1",
    kind: "provider_request",
    provider,
    api,
    retryable,
    ...details,
  };
}
