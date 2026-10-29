// test-category: race
import { afterEach, expect, test } from "bun:test";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";
import type { QueuedMessageRecord } from "../../packages/butler-app/client/ui/src/app/types.ts";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalQueue = useButlerStore.getState().sessionQueue;
const originalChat = useButlerStore.getState().activeChatId;
afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(globalThis, { window: originalWindow });
  useButlerStore.setState({ activeChatId: originalChat, sessionQueue: originalQueue });
});
const queue: QueuedMessageRecord[] = [{
  id: "queue/one", chat_id: "session-one", client_message_id: "client-one", text: "Next message",
  state: "queued", cursor: 1, created_at: "", updated_at: "",
  controls: { model: "stub", reasoning_effort: "none", access_mode: "ask_first", plan_mode: false },
}];

test("Send now posts an empty body and replaces the queue from the response", async () => {
  Object.assign(globalThis, { window: undefined });
  const calls: unknown[] = [];
  globalThis.fetch = (async (path, init) => {
    if (String(path).startsWith("/authority-requests")) return Response.json({ data: { requests: [], permissions: [] } });
    calls.push([path, init?.method, init?.body]);
    return Response.json({ data: { queued_messages: queue } });
  }) as typeof fetch;
  useButlerStore.setState({ activeChatId: "session-one", sessionQueue: [] });
  await useButlerStore.getState().sendQueuedMessageNow("queue/one");
  expect(calls).toEqual([["/session-queue/queue%2Fone/send-now", "POST", "{}"]]);
  expect(useButlerStore.getState().sessionQueue).toEqual(queue);
});

test("a late Send now response cannot replace a different session's queue", async () => {
  Object.assign(globalThis, { window: undefined });
  let respond!: (response: Response) => void;
  globalThis.fetch = ((path: Parameters<typeof fetch>[0]) => String(path).endsWith("/send-now")
    ? new Promise<Response>(resolve => { respond = resolve; })
    : Promise.resolve(Response.json({ data: { requests: [], permissions: [] } }))) as unknown as typeof fetch;
  useButlerStore.setState({ activeChatId: "session-one", sessionQueue: queue });
  const request = useButlerStore.getState().sendQueuedMessageNow("queue/one");
  useButlerStore.setState({ activeChatId: "session-two", sessionQueue: [] });
  respond(Response.json({ data: { queued_messages: queue } }));
  await request;
  expect(useButlerStore.getState().sessionQueue).toEqual([]);
});

test.each([404, 409, 503])("a refused Send now preserves the queue and propagates status %s", async status => {
  Object.assign(globalThis, { window: undefined });
  globalThis.fetch = (async () => Response.json({ error: { code: "queued_message_not_next" } }, { status })) as unknown as typeof fetch;
  useButlerStore.setState({ activeChatId: "session-one", sessionQueue: queue });
  await expect(useButlerStore.getState().sendQueuedMessageNow("queue/one")).rejects.toMatchObject({ status });
  expect(useButlerStore.getState().sessionQueue).toEqual(queue);
});

test("renderer Send now decodes the queue id and forwards action tracing over the desktop bridge", async () => {
  let input: unknown;
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: {
    sendQueuedMessageNow: async (value: unknown) => { input = value; return { queued_messages: queue }; },
  } } });
  const result = await api("/session-queue/queue%2Fone/send-now", { method: "POST", body: "{}" });
  expect(result).toEqual({ queued_messages: queue });
  expect(input).toEqual({ queuedMessageId: "queue/one", traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u) });
});
