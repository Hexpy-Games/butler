import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { BtccInboundDispatcher } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";

test("product App ingress is handled once by the BTCC dispatcher", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-cutover-"));
  const queue = new NativeInboundQueue(butlerData);
  const store = new SessionBindingStore(join(butlerData, "runtime", "sessions.sqlite"));
  try {
    const sessionId = "butler/app-general";
    store.upsert({
      sessionId,
      role: "butler",
      workspacePath: butlerData,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.6-sol",
      transportBindings: [{
        transport: "app",
        accountId: "local",
        peerId: "general",
      }],
    });
    const queued = queue.enqueue({
      eventId: "app:message-cutover",
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: "general" },
      sender: { id: "app-user", displayName: "Butler App" },
      message: {
        id: "message-cutover",
        text: "single BTCC ingress",
        timestamp: "2026-07-24T00:00:00.000Z",
      },
      routingHints: {
        sessionId,
        turnId: "turn-cutover",
      },
    });
    const delivered: string[] = [];
    let handled = 0;
    const dispatcher = new BtccInboundDispatcher();

    const summary = dispatcher.poll({
      queue,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      deliverAction: async (_sessionId, action) => {
        delivered.push(action.message.text ?? "");
        return { ok: true };
      },
      server: {
        async handleInbound() {
          handled += 1;
          return {
            status: "handled",
            route: {
              sessionId,
              role: "butler",
              reason: "session-hint",
              workspacePath: butlerData,
            },
            handlerResult: {
              ok: true,
              handledBy: "btcc-turn-runtime",
              metadata: { text: "BTCC final answer" },
            },
          };
        },
      },
    });
    await dispatcher.waitForIdle();

    expect(summary).toEqual({
      claimed: 1,
      handled: 1,
      delivered: 1,
      failed: 0,
    });
    expect(handled).toBe(1);
    expect(delivered).toEqual(["BTCC final answer"]);
    expect(queue.claim(1)).toEqual([]);
    const processed = join(
      butlerData,
      "runtime",
      "inbound-events",
      "processed",
      `${queued.queueId}.json`,
    );
    expect(existsSync(processed)).toBe(true);
    expect(readFileSync(processed, "utf8")).toContain(
      '"source": "gateway/btcc/btcc-inbound-dispatcher.ts"',
    );
  } finally {
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("a cancelling App Turn is terminalized without entering BTCC", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-cancelled-ingress-"));
  const queue = new NativeInboundQueue(butlerData);
  const store = new SessionBindingStore(join(butlerData, "runtime", "sessions.sqlite"));
  try {
    queue.enqueue({
      eventId: "app:cancelled-before-claim",
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: "general" },
      sender: { id: "app-user" },
      message: {
        id: "cancelled-before-claim",
        text: "must not run",
        timestamp: "2026-07-24T00:00:00.000Z",
      },
      routingHints: {
        sessionId: "butler/app-general",
        turnId: "turn-cancelled-before-claim",
      },
    });
    let handled = false;
    const dispatcher = new BtccInboundDispatcher();
    const summary = dispatcher.poll({
      queue,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      shouldHandleItem: () => false,
      server: {
        async handleInbound() {
          handled = true;
          throw new Error("cancelled ingress must not reach BTCC");
        },
      },
    });
    await dispatcher.waitForIdle();

    expect(summary).toEqual({
      claimed: 1,
      handled: 0,
      delivered: 0,
      failed: 0,
    });
    expect(handled).toBe(false);
  } finally {
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});
