import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEventEnvelope } from
  "../../packages/butler-agent/src/gateways/app/interface/protocol/app-protocol.ts";
import type { AppServerStore } from
  "../../packages/butler-agent/src/gateways/app/application/store/app-server-store.ts";
import { handleRuntimeRoutes } from
  "../../packages/butler-agent/src/gateways/app/interface/server/routes/runtime-routes.ts";
import { liveEventsResponse } from
  "../../packages/butler-agent/src/gateways/app/interface/server/live-events.ts";
import { FixedWindowRateLimiter } from
  "../../packages/butler-agent/src/gateways/app/interface/server/rate-limiter.ts";
import type { AppRouteContext } from
  "../../packages/butler-agent/src/gateways/app/interface/server/server-types.ts";
import { createTestAppServer } from
  "../../packages/butler-agent/src/test-support/app-server.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live event route disables Bun's request idle timeout", async () => {
  const root = temporaryRoot();
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const requestController = new AbortController();
  const serverShutdownController = new AbortController();
  const requestedIdleTimeouts: number[] = [];
  const request = new Request("http://127.0.0.1/events/live?cursor=0", {
    signal: requestController.signal,
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await handleRuntimeRoutes({
      request,
      store: server.store,
      uiRoot: root,
      messageRateLimiter: new FixedWindowRateLimiter(),
      butlerData: root,
      url: new URL(request.url),
      serverShutdownSignal: serverShutdownController.signal,
      setRequestIdleTimeout(seconds) {
        requestedIdleTimeouts.push(seconds);
      },
    } as AppRouteContext);
    expect(response?.ok).toBe(true);
    expect(requestedIdleTimeouts).toEqual([0]);
    reader = response?.body?.getReader();
    if (!reader) throw new Error("Missing live event body.");

    server.store.appendSafeServerEvent("test.before_client_abort", {});
    await readSseEvent(reader, "test.before_client_abort");
    requestController.abort();
    expect(await reader.read()).toEqual({ value: undefined, done: true });
  } finally {
    await reader?.cancel().catch(() => undefined);
    server.stop();
  }
});

test("SSE survives the server idle timeout and shutdown releases its subscription", async () => {
  const root = temporaryRoot();
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
    serverIdleTimeoutSeconds: 1,
  });
  const originalSubscribe = server.store.subscribeEvents.bind(server.store);
  let activeSubscriptions = 0;
  server.store.subscribeEvents = (listener) => {
    activeSubscriptions += 1;
    const unsubscribe = originalSubscribe(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      activeSubscriptions -= 1;
      unsubscribe();
    };
  };
  let stopped = false;
  let firstReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const firstResponsePromise = fetch(`${server.url}events/live?cursor=0`);
    server.store.appendSafeServerEvent("test.first_client", {});
    const firstResponse = await firstResponsePromise;
    firstReader = firstResponse.body?.getReader();
    if (!firstReader) throw new Error("Missing first live event body.");
    await readSseEvent(firstReader, "test.first_client");
    expect(activeSubscriptions).toBe(1);

    await Bun.sleep(1_250);
    server.store.appendSafeServerEvent("test.after_idle_timeout", {});
    await readSseEvent(firstReader, "test.after_idle_timeout");

    expect(activeSubscriptions).toBe(1);
    server.stop();
    stopped = true;
    await waitFor(() => activeSubscriptions === 0);
  } finally {
    await firstReader?.cancel().catch(() => undefined);
    if (!stopped) server.stop();
  }
});

test("client disconnect and server shutdown signals both remove listeners", async () => {
  const root = temporaryRoot();
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const originalSubscribe = server.store.subscribeEvents.bind(server.store);
  let activeSubscriptions = 0;
  server.store.subscribeEvents = (listener) => {
    activeSubscriptions += 1;
    const unsubscribe = originalSubscribe(listener);
    return () => {
      activeSubscriptions -= 1;
      unsubscribe();
    };
  };
  const firstClientController = new AbortController();
  const serverShutdownController = new AbortController();
  const firstResponse = liveEventsResponse(server.store, 0, {
    clientDisconnectSignal: firstClientController.signal,
    serverShutdownSignal: serverShutdownController.signal,
  });
  const firstReader = firstResponse.body?.getReader();
  if (!firstReader) throw new Error("Missing first live event body.");
  let secondReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    expect(activeSubscriptions).toBe(1);
    firstClientController.abort();
    expect(activeSubscriptions).toBe(0);
    expect(await firstReader.read()).toEqual({ value: undefined, done: true });

    const secondResponse = liveEventsResponse(server.store, 0, {
      clientDisconnectSignal: new AbortController().signal,
      serverShutdownSignal: serverShutdownController.signal,
    });
    secondReader = secondResponse.body?.getReader();
    if (!secondReader) throw new Error("Missing second live event body.");
    expect(activeSubscriptions).toBe(1);
    serverShutdownController.abort();
    expect(activeSubscriptions).toBe(0);
    expect(await secondReader.read()).toEqual({ value: undefined, done: true });
  } finally {
    await firstReader.cancel().catch(() => undefined);
    await secondReader?.cancel().catch(() => undefined);
    server.stop();
  }
});

test("live replay queues a synchronous subscription race and emits each cursor once in order", async () => {
  const first = event(1, "replay.first");
  const raced = event(2, "live.raced");
  let unsubscribed = false;
  const store = {
    latestEventCursor: () => 2,
    replayEvents: () => [first],
    subscribeEvents: (next: (value: AppEventEnvelope) => void) => {
      // Real stores can publish synchronously while the replay query is being
      // prepared. The route must hold this until the replay page is emitted.
      next(raced);
      return () => {
        unsubscribed = true;
      };
    },
  } as unknown as AppServerStore;
  const response = liveEventsResponse(store, 0);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing live event body.");
  try {
    expect((await readSseEvent(reader, "replay.first")).id).toBe(1);
    expect((await readSseEvent(reader, "live.raced")).id).toBe(2);
    await reader.cancel();
    expect(unsubscribed).toBe(true);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
});

test("slow SSE consumers receive a bounded reconcile marker and release the reader", async () => {
  const root = temporaryRoot();
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const originalSubscribe = server.store.subscribeEvents.bind(server.store);
  let activeSubscriptions = 0;
  server.store.subscribeEvents = (listener) => {
    activeSubscriptions += 1;
    const unsubscribe = originalSubscribe(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      activeSubscriptions -= 1;
      unsubscribe();
    };
  };
  const response = liveEventsResponse(server.store, 0);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing slow consumer body.");
  try {
    expect(activeSubscriptions).toBe(1);
    // Hold the reader so the stream's desiredSize reaches zero. The live
    // route must collapse the pending queue to a durable resync marker rather
    // than retaining every event emitted by a slow renderer.
    for (let index = 0; index < 200; index += 1) {
      server.store.appendSafeServerEvent(`test.slow_consumer_${index}`, {});
    }
    await readSseEvent(reader, "test.slow_consumer_0");
    const reconcile = await readSseEvent(reader, "stream.reconcile_required");
    expect(reconcile.payload?.high_water_cursor).toBeGreaterThan(0);
    await reader.cancel();
    expect(activeSubscriptions).toBe(0);
  } finally {
    await reader.cancel().catch(() => undefined);
    server.stop();
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "butler-live-events-"));
  temporaryRoots.push(root);
  return root;
}

function event(id: number, type: string): AppEventEnvelope {
  return {
    protocol_version: "butler.app.v1",
    id,
    type,
    created_at: "2026-08-12T00:00:00.000Z",
    payload: {},
  };
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  type: string,
): Promise<AppEventEnvelope> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(250).then(() => {
        throw new Error(`Timed out waiting for SSE event: ${type}`);
      }),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const records = buffer.split("\n\n");
    buffer = records.pop() ?? "";
    for (const record of records) {
      const data = record
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice("data: ".length)) as AppEventEnvelope;
      if (event.type === type) return event;
    }
  }
  throw new Error(`Expected SSE event did not arrive: ${type}`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for live event cleanup.");
}
