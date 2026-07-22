import { afterEach, expect, test } from "bun:test";
import { createOpenAIResponse } from "../../packages/butler-agent/src/integrations/providers/openai/responses-client.ts";
import { ModelProviderRequestError } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { createHostedChatCompletion } from "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-client.ts";
import type { HostedRuntimeConfig } from "../../packages/butler-agent/src/integrations/providers/shared/model-routing.ts";
import {
  DEFAULT_PROVIDER_ROUND_IDLE_TIMEOUT_MS,
  DEFAULT_PROVIDER_ROUND_TIMEOUT_MS,
  resolveProviderRoundPolicy,
} from "../../packages/butler-agent/src/integrations/providers/shared/provider-round-guard.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS;
  delete process.env.BUTLER_PROVIDER_ROUND_TIMEOUT_MS;
  delete process.env.BUTLER_PROVIDER_ROUND_IDLE_TIMEOUT_MS;
});

test("provider-round deadline configuration accepts only positive integer milliseconds", () => {
  process.env.BUTLER_PROVIDER_ROUND_TIMEOUT_MS = "0";
  process.env.BUTLER_PROVIDER_ROUND_IDLE_TIMEOUT_MS = "1.5";
  expect(resolveProviderRoundPolicy()).toEqual({
    totalTimeoutMs: DEFAULT_PROVIDER_ROUND_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_PROVIDER_ROUND_IDLE_TIMEOUT_MS,
  });

  process.env.BUTLER_PROVIDER_ROUND_TIMEOUT_MS = "321";
  process.env.BUTLER_PROVIDER_ROUND_IDLE_TIMEOUT_MS = "123";
  expect(resolveProviderRoundPolicy()).toEqual({
    totalTimeoutMs: 321,
    idleTimeoutMs: 123,
  });
});

test("a Codex stream whose body ignores abort still fails on the idle provider-round deadline", async () => {
  let fetchCalls = 0;
  globalThis.fetch = hangingCodexFetch(() => {
    fetchCalls += 1;
  });
  process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS = "3";

  const error = await captureFailure(() =>
    createTestResponse({
      totalTimeoutMs: 200,
      idleTimeoutMs: 20,
    }),
  );

  expect(error).toBeInstanceOf(ModelProviderRequestError);
  const diagnostic = (error as ModelProviderRequestError).diagnostic();
  expect(diagnostic).toMatchObject({
    code: "provider_round_timeout",
    retryable: true,
    timeoutKind: "idle",
  });
  expect(diagnostic.message).toContain("preserved the current turn checkpoint");
  expect(diagnostic.message).not.toContain("Send a new message");
  expect(JSON.stringify(diagnostic)).not.toContain("test");
  expect(JSON.stringify(diagnostic)).not.toContain("account");
  expect(fetchCalls).toBe(1);
});

test("a hosted chat request that never returns enters provider recovery through the same deadline", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return await new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  const config: HostedRuntimeConfig = {
    providerId: "zai",
    modelId: "glm-5.2",
    modelRef: "zai/glm-5.2",
    authType: "api_key",
    apiKey: "test",
  };

  const error = await captureFailure(() =>
    createHostedChatCompletion(
      config,
      { messages: [{ role: "user", content: "test" }] },
      undefined,
      { roundIndex: 0 },
      3,
      { totalTimeoutMs: 200, idleTimeoutMs: 20 },
    ),
  );

  expect(error).toBeInstanceOf(ModelProviderRequestError);
  expect((error as ModelProviderRequestError).diagnostic()).toMatchObject({
    code: "provider_round_timeout",
    retryable: true,
    timeoutKind: "idle",
  });
  expect(fetchCalls).toBe(1);
});

test("valid JSON SSE events reset idle time until response completion", async () => {
  globalThis.fetch = codexFetchFromSchedule([
    { afterMs: 10, event: { type: "response.in_progress" } },
    { afterMs: 10, event: { type: "response.output_text.delta", delta: "x" } },
    { afterMs: 10, event: completedEvent("ok") },
  ]);

  await expect(
    createTestResponse({
      totalTimeoutMs: 100,
      idleTimeoutMs: 18,
    }),
  ).resolves.toMatchObject({ id: "response-complete", output_text: "x" });
});

test("valid progress cannot extend the absolute provider-round deadline", async () => {
  globalThis.fetch = codexFetchFromSchedule([
    { afterMs: 8, event: { type: "response.in_progress" } },
    { afterMs: 8, event: { type: "response.in_progress" } },
    { afterMs: 8, event: { type: "response.in_progress" } },
    { afterMs: 8, event: completedEvent("late") },
  ]);

  const error = await captureFailure(() =>
    createTestResponse({
      totalTimeoutMs: 22,
      idleTimeoutMs: 15,
    }),
  );

  expect((error as ModelProviderRequestError).diagnostic()).toMatchObject({
    code: "provider_round_timeout",
    timeoutKind: "total",
  });
});

test("empty chunks yield to the deadline and do not count as progress", async () => {
  let pulls = 0;
  globalThis.fetch = (async (_input, init) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull(value) {
        pulls += 1;
        value.enqueue(new Uint8Array());
      },
    });
    init?.signal?.addEventListener(
      "abort",
      () => controller?.error(init.signal?.reason),
      { once: true },
    );
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  const startedAt = performance.now();
  const error = await captureFailure(() =>
    createTestResponse({
      totalTimeoutMs: 200,
      idleTimeoutMs: 20,
    }),
  );

  expect((error as ModelProviderRequestError).diagnostic()).toMatchObject({
    code: "provider_round_timeout",
    timeoutKind: "idle",
  });
  expect(performance.now() - startedAt).toBeLessThan(150);
  expect(pulls).toBeLessThan(1_000);
});

test("external user cancellation wins over a provider-round timeout", async () => {
  globalThis.fetch = hangingCodexFetch();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  const error = await captureFailure(() =>
    createTestResponse(
      {
        totalTimeoutMs: 200,
        idleTimeoutMs: 100,
      },
      controller.signal,
    ),
  );

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("AbortError");
  expect(error).not.toBeInstanceOf(ModelProviderRequestError);
});

function createTestResponse(
  policy: { totalTimeoutMs: number; idleTimeoutMs: number },
  signal?: AbortSignal,
) {
  return createOpenAIResponse(
    { model: "gpt-5.5", input: "test" },
    signal,
    { mode: "codex_subscription", authorization: fakeAuthorization() },
    undefined,
    { roundIndex: 0 },
    policy,
  );
}

function hangingCodexFetch(onCall?: () => void): typeof fetch {
  return (async () => {
    onCall?.();
    const stream = new ReadableStream<Uint8Array>({
      start() {},
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

function codexFetchFromSchedule(
  schedule: Array<{ afterMs: number; event: Record<string, unknown> }>,
): typeof fetch {
  return (async (_input, init) => {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let index = 0;
        const emitNext = () => {
          const item = schedule[index++];
          if (!item) {
            controller.close();
            return;
          }
          timer = setTimeout(() => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(item.event)}\n\n`),
            );
            emitNext();
          }, item.afterMs);
        };
        emitNext();
        init?.signal?.addEventListener(
          "abort",
          () => {
            if (timer) clearTimeout(timer);
            controller.error(init.signal?.reason);
          },
          { once: true },
        );
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
}

function completedEvent(text: string): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id: "response-complete",
      status: "completed",
      output: [],
      output_text: text,
    },
  };
}

function fakeAuthorization(): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `Bearer ${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "account" },
  })}.signature`;
}

async function captureFailure(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}
