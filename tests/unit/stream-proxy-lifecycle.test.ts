import { expect, test } from "bun:test";
import { createPushStreamProxy, createStreamProxy } from
  "../../packages/butler-agent/src/gateways/app/interface/server/stream-proxy-lifecycle.ts";

test("downstream cancellation cancels the upstream reader exactly once", async () => {
  let upstreamCancelled = 0;
  const upstream = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
    },
    cancel() {
      upstreamCancelled += 1;
    },
  });
  const client = new AbortController();
  const proxy = createStreamProxy({
    upstream,
    clientDisconnectSignal: client.signal,
  });
  const reader = proxy.stream.getReader();
  expect(await reader.read()).toMatchObject({ value: 1, done: false });
  await reader.cancel();
  await Bun.sleep(0);
  expect(upstreamCancelled).toBe(1);
  expect(proxy.stats()).toEqual({
    upstreamReaderActive: false,
    listenerCount: 0,
    pendingChunks: 0,
  });
});

test("abort settles both sides and detaches signal listeners", async () => {
  let upstreamCancelled = 0;
  const upstream = new ReadableStream<number>({
    cancel() {
      upstreamCancelled += 1;
    },
  });
  const client = new AbortController();
  const proxy = createStreamProxy({
    upstream,
    clientDisconnectSignal: client.signal,
  });
  const reader = proxy.stream.getReader();
  await waitFor(() => proxy.stats().listenerCount === 1);
  client.abort();
  await waitFor(() => proxy.stats().upstreamReaderActive === false);
  expect(upstreamCancelled).toBe(1);
  expect(proxy.stats().listenerCount).toBe(0);
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  await reader.cancel();
});

test("backpressure replaces an overflowing queue with one reconcile chunk", async () => {
  let next = 0;
  const upstream = new ReadableStream<number>({
    pull(controller) {
      if (next >= 200) {
        return new Promise<void>(() => undefined);
      }
      controller.enqueue(next++);
    },
  });
  const proxy = createStreamProxy({
    upstream,
    maxBufferedChunks: 4,
    overflowChunk: () => -1,
  });
  const reader = proxy.stream.getReader();
  await waitFor(() => proxy.stats().pendingChunks > 0);
  expect(proxy.stats().pendingChunks).toBeLessThanOrEqual(4);
  expect(await reader.read()).toMatchObject({ value: 0, done: false });
  expect(await reader.read()).toMatchObject({ value: -1, done: false });
  await reader.cancel();
});

test("upstream failure errors downstream and releases the reader", async () => {
  const upstream = new ReadableStream<number>({
    pull() {
      throw new Error("upstream failed");
    },
  });
  const proxy = createStreamProxy({ upstream });
  const reader = proxy.stream.getReader();
  await expect(reader.read()).rejects.toThrow("upstream failed");
  expect(proxy.stats().upstreamReaderActive).toBe(false);
  await reader.cancel().catch(() => undefined);
});

test("push proxy invokes producer cleanup once across abort and downstream cancel", async () => {
  let cleanupCalls = 0;
  const client = new AbortController();
  const proxy = createPushStreamProxy({
    clientDisconnectSignal: client.signal,
    onCancel: () => {
      cleanupCalls += 1;
    },
  });
  const reader = proxy.stream.getReader();
  client.abort();
  await waitFor(() => proxy.stats().listenerCount === 0);
  await reader.cancel();
  await proxy.close();
  expect(cleanupCalls).toBe(1);
});

test("push proxy still detaches listeners and clears the queue when cleanup throws", async () => {
  const client = new AbortController();
  const proxy = createPushStreamProxy({
    maxBufferedChunks: 2,
    clientDisconnectSignal: client.signal,
    onCancel: () => {
      throw new Error("producer cleanup failed");
    },
  });
  const reader = proxy.stream.getReader();
  proxy.push(1);
  client.abort();
  await waitFor(() => proxy.stats().listenerCount === 0);
  expect(proxy.stats().pendingChunks).toBe(0);
  await expect(reader.read()).rejects.toThrow("producer cleanup failed");
  await reader.cancel().catch(() => undefined);
  await proxy.close();
});

test("reader lock is released after normal upstream EOF", async () => {
  const upstream = new ReadableStream<number>({
    start(controller) {
      controller.close();
    },
  });
  const proxy = createStreamProxy({ upstream });
  const reader = proxy.stream.getReader();
  await expect(reader.read()).resolves.toEqual({ value: undefined, done: true });
  await waitFor(() => proxy.stats().upstreamReaderActive === false);
  expect(() => upstream.getReader()).not.toThrow();
  await reader.cancel().catch(() => undefined);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for stream proxy lifecycle.");
}
