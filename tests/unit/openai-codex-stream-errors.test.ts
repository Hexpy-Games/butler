import { expect, test } from "bun:test";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import {
  codexSseResponseFromAccumulator,
  createCodexSseAccumulator,
  handleCodexSseEvent,
} from "../../packages/butler-agent/src/integrations/providers/openai/codex-stream.ts";
import { extractResponseText } from
  "../../packages/butler-agent/src/integrations/providers/shared/usage.ts";

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

test("Codex SSE uses the completed text instead of a partial delta projection", () => {
  const accumulator = createCodexSseAccumulator();
  accumulator.fallbackText = '{"carrier":';
  accumulator.output.push({
    type: "message",
    content: [{
      type: "output_text",
      text: '{"carrier":{"kind":"phase_submission"}}',
    }],
  });

  expect(extractResponseText(codexSseResponseFromAccumulator(accumulator)))
    .toBe('{"carrier":{"kind":"phase_submission"}}');
});

async function captureBackendError(event: Record<string, unknown>): Promise<unknown> {
  try {
    await handleCodexSseEvent(createCodexSseAccumulator(), event);
    throw new Error("expected Codex backend failure");
  } catch (error) {
    return error;
  }
}
