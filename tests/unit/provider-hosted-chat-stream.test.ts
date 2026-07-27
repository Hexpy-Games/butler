import { afterEach, expect, test } from "bun:test";
import { createHostedChatCompletion } from
  "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-client.ts";
import type { HostedRuntimeConfig } from
  "../../packages/butler-agent/src/integrations/providers/shared/model-routing.ts";

const originalFetch = globalThis.fetch;
const config: HostedRuntimeConfig = {
  providerId: "zai",
  modelId: "glm-5.2",
  modelRef: "zai/glm-5.2",
  authType: "api_key",
  apiKey: "test",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("SSE events preserve forward progress and structured output", async () => {
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = hostedChatFetchFromSchedule([
    { afterMs: 10, data: {
      id: "chat-stream",
      model: "glm-5.2",
      choices: [{ index: 0, delta: { role: "assistant", content: "{\"kind\":" } }],
    } },
    { afterMs: 10, data: {
      choices: [{ index: 0, delta: { content: "\"accepted\"}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    } },
    { afterMs: 10, data: "[DONE]" },
  ], (body) => {
    requestBody = body;
  });

  const response = await createHostedChatCompletion(
    config,
    { messages: [{ role: "user", content: "test" }], stream: true },
    undefined,
    { roundIndex: 0 },
    1,
    { totalTimeoutMs: 100, idleTimeoutMs: 25 },
  );

  expect(requestBody?.stream).toBe(true);
  expect(response).toMatchObject({
    id: "chat-stream",
    model: "glm-5.2",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "{\"kind\":\"accepted\"}" },
    }],
    usage: { total_tokens: 16 },
  });
});

test("indexed tool-call deltas reconstruct one exact call", async () => {
  globalThis.fetch = hostedChatFetchFromSchedule([
    { afterMs: 1, data: {
      id: "chat-tools",
      model: "glm-5.2",
      choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        id: "call-1",
        type: "function",
        function: { name: "read_", arguments: "{\"pa" },
      }] } }],
    } },
    { afterMs: 1, data: {
      choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        function: { name: "file", arguments: "th\":\"SPEC.md\"}" },
      }] }, finish_reason: "tool_calls" }],
    } },
    { afterMs: 1, data: "[DONE]" },
  ]);

  const response = await createHostedChatCompletion(
    config,
    { messages: [{ role: "user", content: "test" }], stream: true },
    undefined,
    { roundIndex: 0 },
    1,
    { totalTimeoutMs: 100, idleTimeoutMs: 20 },
  );

  expect(response.choices[0].message.tool_calls).toEqual([{
    id: "call-1",
    type: "function",
    function: { name: "read_file", arguments: "{\"path\":\"SPEC.md\"}" },
  }]);
});

test("a partial stream cannot become a provider product", async () => {
  globalThis.fetch = hostedChatFetchFromSchedule([{
    afterMs: 1,
    data: {
      id: "chat-partial",
      model: "glm-5.2",
      choices: [{ index: 0, delta: { content: "partial" } }],
    },
  }]);

  await expect(createHostedChatCompletion(
    config,
    { messages: [{ role: "user", content: "test" }], stream: true },
    undefined,
    { roundIndex: 0 },
    1,
    { totalTimeoutMs: 100, idleTimeoutMs: 20 },
  )).rejects.toMatchObject({ code: "provider_protocol_error" });
});

test("hosted 429 preserves provider-declared readiness", async () => {
  const retryAt = "Wed, 21 Oct 2099 07:28:00 GMT";
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { message: "rate limited" } }),
    { status: 429, headers: { "Retry-After": retryAt } },
  )) as unknown as typeof fetch;

  await expect(createHostedChatCompletion(
    config,
    { messages: [{ role: "user", content: "test" }] },
    undefined,
    { roundIndex: 0 },
    1,
  )).rejects.toMatchObject({
    code: "provider_rate_limited",
    retryAt: new Date(retryAt).toISOString(),
  });
});

function hostedChatFetchFromSchedule(
  schedule: Array<{ afterMs: number; data: Record<string, unknown> | "[DONE]" }>,
  onRequest?: (body: Record<string, unknown>) => void,
): typeof fetch {
  return (async (_input, init) => {
    onRequest?.(JSON.parse(String(init?.body)));
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
            const data = typeof item.data === "string"
              ? item.data
              : JSON.stringify(item.data);
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            emitNext();
          }, item.afterMs);
        };
        emitNext();
        init?.signal?.addEventListener("abort", () => {
          if (timer) clearTimeout(timer);
          controller.error(init.signal?.reason);
        }, { once: true });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}
