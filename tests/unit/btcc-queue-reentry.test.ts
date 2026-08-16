import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import {
  BtccInboundDispatcher,
} from "../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import type { InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";

test("a recovered queue item re-enters the same BTCC path without a resume marker", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-queue-reentry-"));
  const sessionId = "butler/app-general";
  const queue = new NativeInboundQueue(butlerData);
  const store = createSessionStore(butlerData, sessionId);
  try {
    const queued = queue.enqueue(appEnvelope({ sessionId, turnId: "turn-reentry" }));
    await claimInExitedExecutor(butlerData);
    const received: unknown[] = [];
    let releaseDispatch = () => {};
    const dispatchHeld = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const server = {
      async handleInbound(envelope: InboundEnvelope) {
        received.push(envelope);
        await dispatchHeld;
        return handledResult(sessionId, butlerData, "recovered final answer");
      },
    };
    const delivered: string[] = [];
    const options = {
      queue,
      server,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      deliverAction: async (_sessionId: string, action: { message: { text?: string } }) => {
        delivered.push(action.message.text ?? "");
        return { ok: true };
      },
    };
    const first = new BtccInboundDispatcher();
    const second = new BtccInboundDispatcher();
    const firstSummary = first.poll(options);
    const competingSummary = second.poll(options);
    releaseDispatch();
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);

    expect(firstSummary.claimed).toBe(1);
    expect(competingSummary.claimed).toBe(0);
    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).raw).toBeUndefined();
    expect(delivered).toEqual(["recovered final answer"]);
    const processed = readFileSync(join(
      butlerData,
      "runtime",
      "inbound-events",
      "processed",
      `${queued.queueId}.json`,
    ), "utf8");
    expect(processed).toContain('"dispatchStatus": "handled"');
  } finally {
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("queue dispatch does not read or decide from an App lifecycle database", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-queue-no-db-read-"));
  const sessionId = "butler/app-general";
  const queue = new NativeInboundQueue(butlerData);
  const store = createSessionStore(butlerData, sessionId);
  writeFileSync(join(butlerData, "unreadable.sqlite"), "not a sqlite database", "utf8");
  try {
    queue.enqueue(appEnvelope({ sessionId, turnId: "turn-no-db-decision" }));
    let handled = 0;
    const dispatcher = new BtccInboundDispatcher();
    const summary = dispatcher.poll({
      queue,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      server: {
        async handleInbound() {
          handled += 1;
          return handledResult(sessionId, butlerData, "one canonical answer");
        },
      },
    });
    await dispatcher.waitForIdle();
    expect(summary.handled).toBe(1);
    expect(handled).toBe(1);
  } finally {
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("a stale claimed queue item is recovered and sent back through BTCC", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-queue-stale-"));
  const sessionId = "butler/app-general";
  const queue = new NativeInboundQueue(butlerData);
  const store = createSessionStore(butlerData, sessionId);
  try {
    const claimedAt = new Date("2026-07-31T00:00:00.000Z");
    queue.enqueue(appEnvelope({ sessionId, turnId: "turn-stale" }), {}, claimedAt);
    expect(queue.claimEligible(1, () => true, claimedAt, 1)).toHaveLength(1);
    let handled = 0;
    const dispatcher = new BtccInboundDispatcher();
    const summary = dispatcher.poll({
      queue,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      server: {
        async handleInbound() {
          handled += 1;
          return handledResult(sessionId, butlerData, "stale item recovered");
        },
      },
      processingLeaseMs: 1,
      now: () => new Date(claimedAt.getTime() + 2),
    });
    await dispatcher.waitForIdle();
    expect(summary.handled).toBe(1);
    expect(handled).toBe(1);
  } finally {
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function createSessionStore(butlerData: string, sessionId: string): SessionBindingStore {
  const store = new SessionBindingStore(
    join(butlerData, "runtime", "sessions.sqlite"),
    "ephemeral",
  );
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
  return store;
}

function appEnvelope(input: { sessionId: string; turnId: string }) {
  return {
    eventId: `app:${input.turnId}`,
    transport: "app" as const,
    accountId: "local",
    peer: { kind: "dm" as const, id: "general" },
    sender: { id: "app-user" },
    message: {
      id: `message-${input.turnId}`,
      text: "finish this request",
      timestamp: "2026-07-31T00:00:00.000Z",
    },
    routingHints: {
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
  };
}

function handledResult(sessionId: string, butlerData: string, text: string) {
  return {
    status: "handled" as const,
    route: {
      sessionId,
      role: "butler" as const,
      reason: "session-hint" as const,
      workspacePath: butlerData,
    },
    handlerResult: {
      ok: true,
      handledBy: "btcc/turn",
      metadata: {
        text,
        canonicalMessageId: `canonical:${text}`,
        turnId: "turn-reentry",
      },
    },
  };
}

async function claimInExitedExecutor(butlerData: string): Promise<void> {
  const moduleUrl = new URL(
    "../../packages/butler-agent/src/gateways/core/inbound-queue.ts",
    import.meta.url,
  ).href;
  const child = Bun.spawn([
    process.execPath,
    "-e",
    `
      const { NativeInboundQueue } = await import(${JSON.stringify(moduleUrl)});
      const queue = new NativeInboundQueue(${JSON.stringify(butlerData)});
      if (queue.claim(1).length !== 1) process.exit(2);
    `,
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
}
