import { afterEach, expect, test } from "bun:test";
import { createAnthropicMessage } from "../../packages/butler-agent/src/integrations/providers/anthropic/runtime.ts";
import { createGeminiContent } from "../../packages/butler-agent/src/integrations/providers/google/runtime.ts";
import { createLocalChatCompletion } from "../../packages/butler-agent/src/integrations/providers/local/client.ts";
import type { LocalModelConfig } from "../../packages/butler-agent/src/integrations/providers/local/models.ts";
import { createCodexResponse } from "../../packages/butler-agent/src/integrations/providers/openai/codex-stream.ts";
import { createOpenAIResponseOnce } from "../../packages/butler-agent/src/integrations/providers/openai/responses-client.ts";
import { createHostedChatCompletion } from "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-client.ts";
import type { HostedRuntimeConfig } from "../../packages/butler-agent/src/integrations/providers/shared/model-routing.ts";
import {
  admitSerializedProviderRequest,
  ModelRequestAdmissionError,
} from "../../packages/butler-agent/src/integrations/providers/shared/request-context-admission.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("model-token admission is deterministic and bound to the exact request hash", () => {
  const input = {
    providerId: "openai" as const,
    modelRef: "openai/gpt-5.4-mini",
    body: {
      model: "gpt-5.4-mini",
      input: [{ role: "user", content: "안녕하세요" }],
      tools: [{ type: "function", name: "probe", parameters: { type: "object" } }],
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
    },
    requestedOutputTokens: 1024,
    providerEnvelopeTokens: 17,
    turnId: "turn-admission",
    generation: 2,
  };

  const first = admitSerializedProviderRequest(input);
  const second = admitSerializedProviderRequest(input);

  expect(first).toEqual(second);
  expect(first.plan.measurement).toBe("model_token_estimate");
  expect(first.plan.budget_input_tokens).not.toBeNull();
  expect(first.plan.compiled_input_tokens).toBe(first.plan.budget_input_tokens!);
  expect(first.plan.compiled_input_tokens).toBeLessThan(
    Buffer.byteLength(first.serialized_request, "utf8") + 17,
  );
  expect(first.plan.admission).toBe("admitted");
  expect(first.plan.tool_schema_tokens).toBeGreaterThan(0);
  expect(first.plan.turn_id).toBe("turn-admission");
  expect(first.plan.generation).toBe(2);
  expect(first.metric).toMatchObject({
    name: "model_request_context_admission",
    status: "ok",
    value: first.plan.compiled_input_tokens,
  });
});

test("serialized admission exposes only measured spend and request identity to the budget gate", () => {
  const observations: Array<Record<string, unknown>> = [];
  const receipt = admitSerializedProviderRequest({
    providerId: "openai",
    modelRef: "openai/gpt-5.4-mini",
    body: { model: "gpt-5.4-mini", input: "private prompt must not escape" },
    requestedOutputTokens: 2048,
    roundIndex: 3,
    usageAttribution: {
      phase: "review",
      beforeAdmittedModelRequest: (input) => observations.push(input),
    },
  });

  expect(observations).toEqual([{
    roundIndex: 3,
    phase: "review",
    admittedPromptTokens: receipt.plan.budget_input_tokens,
    requestedOutputTokens: 2048,
    requestHash: receipt.serialized_request_sha256,
  }]);
  expect(JSON.stringify(observations)).not.toContain("private prompt");
});

test("shared provider admission measures and admits the exact request body", () => {
  const body = {
    model: "gpt-5.4-mini",
    messages: [{
      role: "tool",
      content: JSON.stringify({
        ok: true,
        output: { content: "EXACT_TOOL_RESULT", nested: { count: 3 } },
      }),
    }],
  };
  const receipt = admitSerializedProviderRequest({
    providerId: "openai",
    modelRef: "openai/gpt-5.4-mini",
    body,
    requestedOutputTokens: 1024,
  });

  expect(receipt.serialized_request).toBe(JSON.stringify(body));
  expect(JSON.parse(receipt.serialized_request)).toEqual(body);
  expect(receipt.serialized_request).toContain("EXACT_TOOL_RESULT");
  expect(receipt.serialized_request).not.toContain("completed-tool-evidence");
  expect(receipt.serialized_request).not.toContain("evidence_packet");
});

test("image inputs keep exact transport bytes without counting base64 as text", () => {
  const imageUrl = `data:image/jpeg;base64,${"A".repeat(600_000)}`;
  const body = {
    model: "gpt-5.4-mini",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Inspect this rendered page." },
        { type: "input_image", image_url: imageUrl, detail: "high" },
      ],
    }],
  };
  const receipt = admitSerializedProviderRequest({
    providerId: "openai",
    modelRef: "openai/gpt-5.4-mini",
    body,
    requestedOutputTokens: 1_024,
    maxInputTokens: 20_000,
  });

  expect(receipt.plan.admission).toBe("admitted");
  expect(receipt.plan.compiled_input_tokens).toBeGreaterThanOrEqual(8_192);
  expect(receipt.plan.compiled_input_tokens).toBeLessThan(20_000);
  expect(receipt.serialized_request).toBe(JSON.stringify(body));
  expect(receipt.serialized_request).toContain(imageUrl.slice(-1_000));
});

test("Codex subscription transport reserves output spend without sending an unsupported field", async () => {
  const observations: Array<Record<string, unknown>> = [];
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = (async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    requestBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response([
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"ok"}]}}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 });
  }) as unknown as typeof fetch;

  const authorization = `Bearer ${fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "account" },
  })}`;
  await expect(createCodexResponse(
    { model: "gpt-5.5", input: "hello" },
    authorization,
    undefined,
    undefined,
    {
      roundIndex: 2,
      attribution: {
        phase: "finalization",
        requestedOutputTokens: 8192,
        beforeAdmittedModelRequest: (input) => observations.push(input),
      },
    },
  )).resolves.toMatchObject({
    output: [expect.objectContaining({
      content: [expect.objectContaining({ text: "ok" })],
    })],
  });

  expect(requestBody.max_output_tokens).toBeUndefined();
  expect(observations).toEqual([
    expect.objectContaining({
      roundIndex: 2,
      phase: "finalization",
      requestedOutputTokens: 8192,
    }),
  ]);
});

test("unknown model capacity and excessive output reserve fail closed", () => {
  expect(() => admitSerializedProviderRequest({
    providerId: "openai",
    modelRef: "openai/not-registered",
    body: { model: "not-registered", input: "hello" },
  })).toThrow(ModelRequestAdmissionError);

  try {
    admitSerializedProviderRequest({
      providerId: "local",
      modelRef: "local/test-model",
      body: { model: "test-model", messages: [] },
      contextWindowTokens: 100,
      maxOutputTokens: 20,
      requestedOutputTokens: 21,
    });
    throw new Error("expected output admission to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelRequestAdmissionError);
    expect((error as ModelRequestAdmissionError).code).toBe("model_request_output_capacity_exceeded");
  }
});

test("every provider client blocks an oversized serialized request before fetch", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({});
  }) as unknown as typeof fetch;

  const openAiOversized = Array.from(
    { length: 100_000 },
    (_, index) => `field_${index}:value_${index % 997}`,
  ).join(" ");
  const characterEstimatedOversized = "abcd ".repeat(900_000);
  const hostedConfig: HostedRuntimeConfig = {
    providerId: "xai",
    modelId: "grok-4.3",
    modelRef: "xai/grok-4.3",
    authType: "api_key",
    apiKey: "test",
  };
  const anthropicConfig: HostedRuntimeConfig = {
    providerId: "anthropic",
    modelId: "claude-haiku-4-5",
    modelRef: "anthropic/claude-haiku-4-5",
    authType: "api_key",
    apiKey: "test",
  };
  const googleConfig: HostedRuntimeConfig = {
    providerId: "google",
    modelId: "gemini-3.1-pro",
    modelRef: "google/gemini-3.1-pro",
    authType: "api_key",
    apiKey: "test",
  };
  const localConfig: LocalModelConfig = {
    provider_id: "local",
    provider_label: "Local",
    model_id: "test-model",
    model_ref: "local/test-model",
    display_name: "Test model",
    api_type: "openai_compatible",
    platform: "custom",
    server_url: "http://127.0.0.1:1234",
    api_base_url: "http://127.0.0.1:1234/v1",
    context_window_tokens: 100,
    max_output_tokens: 20,
    token_estimator: "character_estimate",
    source: "manual",
    source_url: "test",
    runtime_supported: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
  const fakeCodexAuthorization = `Bearer ${fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "account" },
  })}`;

  const calls = [
    () => createOpenAIResponseOnce(
      { model: "not-registered", input: "small but capacity is unknown" },
      undefined,
      { mode: "api_key", authorization: "Bearer test" },
    ),
    () => createOpenAIResponseOnce(
      { model: "gpt-5.4-mini", input: openAiOversized },
      undefined,
      { mode: "api_key", authorization: "Bearer test" },
    ),
    () => createCodexResponse(
      { model: "gpt-5.4-mini", input: openAiOversized },
      fakeCodexAuthorization,
    ),
    () => createHostedChatCompletion(hostedConfig, {
      messages: [{ role: "user", content: characterEstimatedOversized }],
    }),
    () => createAnthropicMessage(anthropicConfig, {
      messages: [{ role: "user", content: characterEstimatedOversized }],
    }),
    () => createGeminiContent(googleConfig, {
      contents: [{ role: "user", parts: [{ text: characterEstimatedOversized }] }],
    }),
    () => createLocalChatCompletion(localConfig, {
      model: "test-model",
      messages: [{ role: "user", content: characterEstimatedOversized }],
    }),
  ];

  for (const call of calls) {
    await expect(call()).rejects.toBeInstanceOf(ModelRequestAdmissionError);
  }
  expect(fetchCalls).toBe(0);
});

test("provider overflow after successful admission is a safe invariant violation", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { message: "maximum context length exceeded" },
  }), { status: 400 })) as unknown as typeof fetch;

  try {
    await createOpenAIResponseOnce({
      model: "gpt-5.4-mini",
      input: [{ role: "user", content: "small admitted request" }],
    } as any);
    throw new Error("expected provider overflow");
  } catch (error) {
    const typed = error as {
      code: string;
      requestGeneration: number;
      provider: string;
      diagnostic(): Record<string, unknown>;
    };
    expect(typed.code).toBe("admission_invariant_violation");
    expect(typed.requestGeneration).toBe(0);
    expect(typed.provider).toBe("openai-codex");
    const diagnostic = typed.diagnostic();
    expect(diagnostic.requestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(diagnostic.measuredInputTokens).toBeGreaterThan(0);
    expect(diagnostic.registeredInputCapacity).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostic)).not.toContain("small admitted request");
  }
});

test("serialized model-token estimates do not under-report provider usage fixtures", () => {
  const fixtures = [
    { providerId: "openai" as const, modelRef: "openai/gpt-5.5", reportedInputTokens: 19_245 },
    { providerId: "anthropic" as const, modelRef: "anthropic/claude-opus-4-7", reportedInputTokens: 18_991 },
    { providerId: "google" as const, modelRef: "google/gemini-3.1-pro", reportedInputTokens: 18_740 },
    { providerId: "xai" as const, modelRef: "xai/grok-4.3", reportedInputTokens: 18_600 },
  ];
  const payload = "한글과 ASCII가 섞인 모델 입력입니다. ".repeat(6000);

  for (const fixture of fixtures) {
    const receipt = admitSerializedProviderRequest({
      providerId: fixture.providerId,
      modelRef: fixture.modelRef,
      body: { messages: [{ role: "user", content: payload }] },
      requestedOutputTokens: 1024,
    });
    expect(receipt.plan.compiled_input_tokens).toBeGreaterThanOrEqual(fixture.reportedInputTokens);
  }
});

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}
