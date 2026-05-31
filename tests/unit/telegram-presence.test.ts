import { afterEach, expect, test } from "bun:test";
import { createTelegramTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/telegram/adapter.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("telegram transport maps typing presence to sendChatAction", async () => {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = init?.body instanceof URLSearchParams
      ? init.body
      : new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url: String(input), body });
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;

  const adapter = createTelegramTransportAdapter({
    botToken: "test-token",
    apiBase: "https://telegram.test",
  });
  const result = await adapter.send({
    actionId: "presence-1",
    transport: "telegram",
    accountId: "default",
    peer: {
      kind: "group",
      id: "123",
      threadId: "456",
    },
    message: {},
    presence: {
      kind: "typing",
    },
  });

  expect(result.ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://telegram.test/bottest-token/sendChatAction");
  expect(calls[0]!.body.get("chat_id")).toBe("123");
  expect(calls[0]!.body.get("message_thread_id")).toBe("456");
  expect(calls[0]!.body.get("action")).toBe("typing");
});
