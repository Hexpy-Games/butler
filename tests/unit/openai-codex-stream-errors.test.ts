import { expect, test } from "bun:test";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import {
  createCodexSseAccumulator,
  handleCodexSseEvent,
} from "../../packages/butler-agent/src/integrations/providers/openai/codex-stream.ts";

test("Codex SSE overload is a retryable provider interruption", async () => {
  const error = await captureBackendError({
    type: "error",
    error: {
      type: "service_unavailable_error",
      code: "server_is_overloaded",
      message: "Our servers are currently overloaded.",
    },
  });

  expect(error).toBeInstanceOf(ModelProviderRequestError);
  expect((error as ModelProviderRequestError).diagnostic()).toMatchObject({
    code: "provider_api_error",
    provider: "openai-codex",
    api: "codex_responses",
    statusCode: 503,
    retryable: true,
  });
});

test("Codex SSE invalid request remains a non-retryable provider action failure", async () => {
  const error = await captureBackendError({
    type: "response.failed",
    response: {
      error: { type: "invalid_request_error", code: "invalid_schema", message: "Invalid schema." },
    },
  });
  expect((error as ModelProviderRequestError).diagnostic()).toMatchObject({
    statusCode: 400,
    retryable: false,
  });
});

async function captureBackendError(event: Record<string, unknown>): Promise<unknown> {
  try {
    await handleCodexSseEvent(createCodexSseAccumulator(), event);
    throw new Error("expected Codex backend failure");
  } catch (error) {
    return error;
  }
}
