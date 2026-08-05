import { afterEach, expect, test } from "bun:test";
import { createAnthropicMessage } from
  "../../packages/butler-agent/src/integrations/providers/anthropic/runtime.ts";
import { createGeminiContent } from
  "../../packages/butler-agent/src/integrations/providers/google/runtime.ts";
import { createOpenAIResponseOnce } from
  "../../packages/butler-agent/src/integrations/providers/openai/responses-client.ts";
import { handleCodexSseEvent } from
  "../../packages/butler-agent/src/integrations/providers/openai/codex-stream.ts";
import {
  createHostedChatCompletion,
} from "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-client.ts";
import { createHostedResponse } from
  "../../packages/butler-agent/src/integrations/providers/shared/hosted-responses-client.ts";
import {
  ModelProviderRequestError,
  normalizeProviderErrorCode,
  providerHttpError,
} from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import type { HostedRuntimeConfig } from
  "../../packages/butler-agent/src/integrations/providers/shared/model-routing.ts";

const originalFetch = globalThis.fetch;

const hostedConfig: HostedRuntimeConfig = {
  providerId: "zai",
  modelId: "glm-5.2",
  modelRef: "zai/glm-5.2",
  authType: "api_key",
  apiKey: "test-key",
};

const responsesConfig: HostedRuntimeConfig = {
  providerId: "xai",
  modelId: "grok-4.5",
  modelRef: "xai/grok-4.5",
  authType: "api_key",
  apiKey: "test-key",
};

const anthropicConfig: HostedRuntimeConfig = {
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  modelRef: "anthropic/claude-sonnet-5",
  authType: "api_key",
  apiKey: "test-key",
};

const googleConfig: HostedRuntimeConfig = {
  providerId: "google",
  modelId: "gemini-3.1-pro",
  modelRef: "google/gemini-3.1-pro",
  authType: "api_key",
  apiKey: "test-key",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("status-only wrong endpoint responses remain surface failures", () => {
  for (const statusCode of [402, 404, 410]) {
    const error = providerHttpError({
      provider: "zai",
      api: "chat_completions",
      statusCode,
      providerError: { message: "Not Found" },
    });
    expect(error.code).toBe("provider_api_error");
    expect(error.providerErrorCode).toBeUndefined();
    expect(error.providerErrorType).toBeUndefined();
  }
});

test("hosted chat preserves an explicit model-not-found body and maps it for routing", async () => {
  globalThis.fetch = responseErrorFetch({
    error: {
      type: "invalid_request_error",
      code: "model_not_found",
      message: "The requested model does not exist.",
      details: { parameter: "model" },
    },
  }, 404);

  const error = await captureProviderError(() => createHostedChatCompletion(
    hostedConfig,
    { messages: [{ role: "user", content: "hello" }] },
    undefined,
    { roundIndex: 0 },
    1,
  ));

  expect(error.diagnostic()).toMatchObject({
    code: "provider_model_not_found",
    statusCode: 404,
    providerErrorCode: "model_not_found",
    providerErrorType: "invalid_request_error",
    providerErrorDetails: { parameter: "model" },
  });
});

test("hosted chat SSE preserves a structured provider failure event", async () => {
  const event = {
    error: {
      type: "invalid_request_error",
      code: "model_not_found",
      message: "The requested model was not found.",
      details: { source: "stream" },
    },
  };
  globalThis.fetch = (async () => new Response(
    `data: ${JSON.stringify(event)}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )) as unknown as typeof fetch;

  const error = await captureProviderError(() => createHostedChatCompletion(
    hostedConfig,
    { messages: [{ role: "user", content: "hello" }], stream: true },
    undefined,
    { roundIndex: 0 },
    1,
  ));
  expect(error.diagnostic()).toMatchObject({
    code: "provider_model_not_found",
    providerErrorCode: "model_not_found",
    providerErrorDetails: { source: "stream" },
  });
});

test("hosted Responses maps explicit quota evidence while preserving provider fields", async () => {
  globalThis.fetch = responseErrorFetch({
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message: "You exceeded the quota for this account.",
      details: { plan: "test" },
    },
  }, 429);

  const error = await captureProviderError(() => createHostedResponse(
    responsesConfig,
    { input: "hello" },
    undefined,
    { roundIndex: 0 },
    1,
  ));

  expect(error.diagnostic()).toMatchObject({
    code: "provider_quota_exhausted",
    statusCode: 429,
    providerErrorCode: "insufficient_quota",
    providerErrorType: "insufficient_quota",
    providerErrorDetails: { plan: "test" },
  });
});

test("Anthropic not-found and Gemini model body variants map explicitly", async () => {
  globalThis.fetch = responseErrorFetch({
    type: "error",
    error: {
      type: "not_found_error",
      message: "model claude-sonnet-5 was not found",
    },
  }, 404);
  const anthropicError = await captureProviderError(() => createAnthropicMessage(
    anthropicConfig,
    { messages: [{ role: "user", content: "hello" }] },
    undefined,
    { roundIndex: 0 },
    1,
  ));
  expect(anthropicError.code).toBe("provider_model_not_found");
  expect(anthropicError.providerErrorType).toBe("not_found_error");

  globalThis.fetch = responseErrorFetch({
    error: {
      code: 404,
      status: "NOT_FOUND",
      message: "models/gemini-3.1-pro is not found",
      details: [{ reason: "MODEL_NOT_FOUND" }],
    },
  }, 404);
  const googleError = await captureProviderError(() => createGeminiContent(
    googleConfig,
    { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    undefined,
    { roundIndex: 0 },
    1,
  ));
  expect(googleError.diagnostic()).toMatchObject({
    code: "provider_model_not_found",
    providerErrorType: "NOT_FOUND",
    providerErrorDetails: [{ reason: "MODEL_NOT_FOUND" }],
  });
});

test("OpenAI Responses and Codex structured quota/model failures map from their native bodies", async () => {
  globalThis.fetch = responseErrorFetch({
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message: "The account has insufficient quota.",
    },
  }, 429);
  const openAiError = await captureProviderError(() => createOpenAIResponseOnce(
    { model: "gpt-5.5", input: "hello" },
    undefined,
    { mode: "api_key", authorization: "Bearer test-key" },
  ));
  expect(openAiError.code).toBe("provider_quota_exhausted");
  expect(openAiError.providerErrorCode).toBe("insufficient_quota");

  const codexError = await captureProviderError(async () => {
    await handleCodexSseEvent(
      { output: [], completed: null, fallbackText: "", sequence: 0, fallbackStreamId: "test" },
      {
        type: "response.failed",
        response: {
          error: {
            type: "invalid_request_error",
            code: "model_not_found",
            message: "The requested model was not found.",
          },
        },
      },
    );
  });
  expect(codexError).toMatchObject({
    code: "provider_model_not_found",
    providerErrorCode: "model_not_found",
    providerErrorType: "invalid_request_error",
  });
});

test("normalization does not infer a model failure from a generic provider message", () => {
  expect(normalizeProviderErrorCode("google", {
    type: "not_found_error",
    message: "The requested URL was not found.",
  })).toBeUndefined();
  expect(normalizeProviderErrorCode("google", {
    type: "not_found_error",
    message: "The model endpoint was not found.",
  })).toBeUndefined();
  expect(normalizeProviderErrorCode("openai", {
    type: "rate_limit_error",
    message: "Too many requests.",
  })).toBeUndefined();
});

test("ordinary provider auth, invalid-request, and transient statuses keep their existing policy", () => {
  const auth = providerHttpError({
    provider: "openai",
    api: "responses",
    statusCode: 401,
    providerError: { error: { type: "authentication_error", message: "invalid key" } },
  });
  expect(auth.code).toBe("provider_auth_error");
  expect(auth.retryable).toBe(false);

  const invalid = providerHttpError({
    provider: "openai",
    api: "responses",
    statusCode: 400,
    providerError: { error: { type: "invalid_request_error", code: "invalid_schema" } },
  });
  expect(invalid.code).toBe("provider_api_error");
  expect(invalid.retryable).toBe(false);

  const transient = providerHttpError({
    provider: "openai",
    api: "responses",
    statusCode: 503,
    providerError: { error: { type: "server_error", message: "upstream unavailable" } },
  });
  expect(transient.code).toBe("provider_api_error");
  expect(transient.retryable).toBe(true);
});

test("structured provider details are bounded and redact credential-shaped keys", () => {
  const error = providerHttpError({
    provider: "openai",
    api: "responses",
    statusCode: 404,
    providerError: {
      error: {
        code: "model_not_found",
        details: {
          model: "gpt-5.5",
          token: "secret-token",
          nested: { authorization: "Bearer secret-token" },
        },
      },
    },
  });
  expect(error.providerErrorDetails).toEqual({
    model: "gpt-5.5",
    token: "[redacted]",
    nested: { authorization: "[redacted]" },
  });
});

function responseErrorFetch(body: unknown, status: number): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

async function captureProviderError(
  action: () => Promise<unknown>,
): Promise<ModelProviderRequestError> {
  try {
    await action();
    throw new Error("expected provider failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelProviderRequestError);
    return error as ModelProviderRequestError;
  }
}
