import { afterEach, expect, test } from "bun:test";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import {
  codexSseResponseFromAccumulator,
  createCodexResponse,
  createCodexSseAccumulator,
  handleCodexSseEvent,
  readCodexSseResponse,
} from "../../packages/butler-agent/src/integrations/providers/openai/codex-stream.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";
import { extractResponseText } from
  "../../packages/butler-agent/src/integrations/providers/shared/usage.ts";
import {
  buildModelRoute,
  createModelRoutePort,
} from "../../packages/butler-agent/src/agent/btcc/model-route/index.ts";

const originalFetch = globalThis.fetch;
const originalRetryDelay = process.env.BUTLER_MODEL_API_RETRY_DELAY_MS;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRetryDelay === undefined) {
    delete process.env.BUTLER_MODEL_API_RETRY_DELAY_MS;
  } else {
    process.env.BUTLER_MODEL_API_RETRY_DELAY_MS = originalRetryDelay;
  }
});

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

test("Codex SSE cancels an unfinished reader after a provider stream failure", async () => {
  let cancelled = false;
  const event = {
    type: "response.failed",
    response: {
      error: {
        type: "service_unavailable_error",
        code: "server_is_overloaded",
        message: "Our servers are currently overloaded.",
      },
    },
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify(event)}\n\n`,
      ));
    },
    cancel() {
      cancelled = true;
    },
  });

  await expect(readCodexSseResponse(new Response(stream)))
    .rejects.toBeInstanceOf(ModelProviderRequestError);
  expect(cancelled).toBe(true);
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

test("Codex body-reader failures become typed retryable stream interruptions", async () => {
  globalThis.fetch = (async () => new Response(interruptedCodexStream())) as unknown as typeof fetch;

  const error = await captureError(() => createCodexResponse(
    { model: "gpt-5.5", input: "hello" },
    codexAuthorization(),
  ));

  expect(error).toBeInstanceOf(ModelProviderRequestError);
  expect((error as ModelProviderRequestError).diagnostic()).toMatchObject({
    code: "provider_stream_interrupted",
    provider: "openai-codex",
    api: "codex_responses",
    retryable: true,
    cause: "terminated",
  });
});

test("Codex EOF before response.completed is a typed stream interruption", async () => {
  globalThis.fetch = (async () => new Response(codexFrames({
    type: "response.output_item.done",
    item: {
      type: "message",
      content: [{ type: "output_text", text: "partial" }],
    },
  }))) as unknown as typeof fetch;

  const error = await captureError(() => createCodexResponse(
    { model: "gpt-5.5", input: "hello" },
    codexAuthorization(),
  ));

  expect(error).toBeInstanceOf(ModelProviderRequestError);
  expect((error as ModelProviderRequestError).code).toBe("provider_stream_interrupted");
});

test("Codex empty body without response.completed is a typed stream interruption", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

  const error = await captureError(() => createCodexResponse(
    { model: "gpt-5.5", input: "hello" },
    codexAuthorization(),
  ));

  expect(error).toBeInstanceOf(ModelProviderRequestError);
  expect((error as ModelProviderRequestError).code).toBe("provider_stream_interrupted");
});

test("Codex cancellation is not converted into a retryable stream interruption", async () => {
  const abort = new AbortController();
  globalThis.fetch = (async (
    _url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const rejectCancellation = () => {
        controller.error(new DOMException("aborted", "AbortError"));
      };
      if (init?.signal?.aborted) rejectCancellation();
      else init?.signal?.addEventListener("abort", rejectCancellation, { once: true });
    },
  }))) as unknown as typeof fetch;

  const pending = createCodexResponse(
    { model: "gpt-5.5", input: "hello" },
    codexAuthorization(),
    abort.signal,
  );
  abort.abort();
  const error = await captureError(() => pending);

  expect(error).not.toBeInstanceOf(ModelProviderRequestError);
  expect((error as Error).name).toBe("AbortError");
});

test("Codex response.completed remains successful when the socket fails afterward", async () => {
  globalThis.fetch = (async () => new Response(completedThenErrorCodexStream())) as unknown as typeof fetch;

  const response = await createCodexResponse(
    { model: "gpt-5.5", input: "hello" },
    codexAuthorization(),
  );

  expect(response.id).toBe("resp-before-socket-error");
  expect(extractResponseText(response)).toBe("complete before socket error");
});

test("Codex parser collaborators do not become retryable transport failures", async () => {
  let progressCalls = 0;
  globalThis.fetch = (async () => new Response(codexFrames({
    type: "response.in_progress",
    response: { id: "resp-internal" },
  }))) as unknown as typeof fetch;

  const error = await captureError(() => createCodexResponse(
    { model: "gpt-5.5", input: "hello" },
    codexAuthorization(),
    undefined,
    undefined,
    undefined,
    () => {
      progressCalls += 1;
      if (progressCalls > 1) throw new Error("progress invariant failed");
    },
  ));

  expect(progressCalls).toBe(2);
  expect(error).not.toBeInstanceOf(ModelProviderRequestError);
  expect((error as Error).message).toBe("progress invariant failed");
});

test("Codex model route retries an interrupted stream with identical request bytes", async () => {
  process.env.BUTLER_MODEL_API_RETRY_DELAY_MS = "0";
  const requestBodies: string[] = [];
  const routeEvents: Array<{ type: string; errorCode?: string; failureDisposition?: string }> = [];
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls += 1;
    requestBodies.push(String(init?.body));
    if (calls === 1) {
      return new Response(interruptedCodexStream({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "partial-call",
          name: "must_not_execute",
          arguments: "{}",
        },
      }));
    }
    return new Response(codexFrames(
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          content: [{ type: "output_text", text: "complete" }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp-complete",
          status: "completed",
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        },
      },
    ));
  }) as typeof fetch;

  const routed = createModelRoutePort({
    base: {
      runRound: (request) => runOpenAIModelRound(request, {
        mode: "codex_oauth",
        authorization: codexAuthorization(),
      }),
    },
    turnId: "turn-stream-retry",
    route: buildModelRoute({
      primaryModelRef: "openai/gpt-5.5",
      backupModelRefs: [],
      reasoningEffort: "medium",
      retryCeiling: 2,
      catalogGeneration: "stream-retry-test",
    }),
    onRouteEvent: (event) => {
      routeEvents.push(event);
    },
  });
  const response = await routed.runRound({
    roundId: "round-stream-retry",
    model: "openai/gpt-5.5",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  });

  expect(calls).toBe(2);
  expect(requestBodies[1]).toBe(requestBodies[0]);
  expect(response.text).toBe("complete");
  expect(response.toolCalls).toEqual([]);
  expect(response.continuation).toMatchObject({ responseId: "resp-complete" });
  expect(JSON.stringify(response)).not.toContain("partial-call");
  expect(routeEvents).toEqual([
    expect.objectContaining({ type: "model.attempt.started" }),
    expect.objectContaining({
      type: "model.attempt.failed",
      errorCode: "provider_stream_interrupted",
      failureDisposition: "retry",
    }),
    expect.objectContaining({ type: "model.attempt.started" }),
    expect.objectContaining({ type: "model.attempt.succeeded" }),
  ]);
});

async function captureBackendError(event: Record<string, unknown>): Promise<unknown> {
  try {
    await handleCodexSseEvent(createCodexSseAccumulator(), event);
    throw new Error("expected Codex backend failure");
  } catch (error) {
    return error;
  }
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    throw new Error("expected provider failure");
  } catch (error) {
    return error;
  }
}

function interruptedCodexStream(
  event: Record<string, unknown> = {
    type: "response.output_text.delta",
    response_id: "resp-partial",
    delta: "partial",
  },
): ReadableStream<Uint8Array> {
  let pull = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pull += 1;
      if (pull === 1) {
        controller.enqueue(new TextEncoder().encode(codexFrames(event)));
        return;
      }
      controller.error(new TypeError("terminated"));
    },
  });
}

function codexFrames(...events: Array<Record<string, unknown>>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function completedThenErrorCodexStream(): ReadableStream<Uint8Array> {
  let pull = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pull += 1;
      if (pull === 1) {
        controller.enqueue(new TextEncoder().encode(codexFrames(
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              content: [{ type: "output_text", text: "complete before socket error" }],
            },
          },
          {
            type: "response.completed",
            response: { id: "resp-before-socket-error", status: "completed" },
          },
        )));
        return;
      }
      controller.error(new TypeError("late socket failure"));
    },
  });
}

function codexAuthorization(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
  })).toString("base64url");
  return `Bearer ${header}.${payload}.signature`;
}
