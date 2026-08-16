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
import { createAppTransportAdapter } from
  "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { readTranscript } from
  "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import {
  cleanupTranscriptProjectionHarnesses,
  createTranscriptProjectionHarness,
} from "./support/transcript-projection-harness.ts";
import { sessionHintForRow } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";

test("product App ingress is handled once by the BTCC dispatcher", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-cutover-"));
  const queue = new NativeInboundQueue(butlerData);
  const store = new SessionBindingStore(
    join(butlerData, "runtime", "sessions.sqlite"),
    "ephemeral",
  );
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
      interrupted: 0,
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

test("cancellation ack keeps its transcript discriminator through App projection", async () => {
  const harness = createTranscriptProjectionHarness();
  const queue = new NativeInboundQueue(harness.root);
  const store = new SessionBindingStore(
    join(harness.root, "runtime", "sessions.sqlite"),
    "ephemeral",
  );
  const turnId = "turn-cancel-ack-cutover";
  const sessionId = sessionHintForRow(harness.chatId);
  const now = new Date().toISOString();
  try {
    store.upsert({
      sessionId,
      role: "butler",
      workspacePath: harness.root,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.6-sol",
      transportBindings: [{
        transport: "app",
        accountId: "local",
        peerId: harness.chatId,
      }],
    });
    harness.db.query(`
      INSERT INTO turns (
        id, chat_id, user_message_id, state, safe_status_label, retryable,
        cancellable, attempt, created_at, updated_at
      ) VALUES (?, ?, 'user-message', 'cancelling', 'Cancelling', 0, 0, 1, ?, ?)
    `).run(turnId, harness.chatId, now, now);
    harness.db.query(`
      INSERT INTO app_turn_cancel_outbox (turn_id, state, created_at)
      VALUES (?, 'pending', ?)
    `).run(turnId, now);
    queue.enqueue({
      eventId: "app:cancel-ack-cutover",
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: harness.chatId },
      sender: { id: "app-user" },
      message: { id: "cancel-message", text: "", timestamp: now },
      routingHints: { sessionId, turnId },
      control: {
        kind: "cancel_turn",
        requestId: "cancel-request",
        turnId,
        requestedAt: now,
      },
    });
    const dispatcher = new BtccInboundDispatcher();
    dispatcher.poll({
      queue,
      store,
      deliveryGuard: new DeliveryGuard({
        adapters: [createAppTransportAdapter()],
        butlerData: harness.root,
      }),
      server: {
        async handleInbound() {
          return {
            status: "handled",
            route: {
              sessionId,
              role: "butler",
              reason: "session-hint",
              workspacePath: harness.root,
            },
            handlerResult: {
              ok: true,
              handledBy: "btcc/turn-stop",
              metadata: {
                controlAck: {
                  kind: "cancel_turn",
                  requestId: "cancel-request",
                  turnId,
                  outcome: "already_finalizing",
                },
              },
            },
          };
        },
      },
    });
    await dispatcher.waitForIdle();

    const outbound = readTranscript(sessionId, harness.root).find(
      (event) => event.kind === "outbound",
    );
    expect(outbound?.payload.metadata).toMatchObject({
      kind: "turn_cancellation_ack",
      requestId: "cancel-request",
      turnId,
      outcome: "already_finalizing",
    });
    const projection = harness.createProjectionStore();
    while (projection.syncNextBatch()) {
      // Drain the bounded transcript projector through outbound and delivery.
    }
    expect(harness.db.query<{ state: string }, [string]>(`
      SELECT state FROM app_turn_cancel_outbox WHERE turn_id = ?
    `).get(turnId)?.state).toBe("accepted");
  } finally {
    store.close();
    harness.close();
    cleanupTranscriptProjectionHarnesses();
  }
});

test("final transcript append survives a crash before inbound queue completion", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-final-before-queue-complete-"));
  const queue = new NativeInboundQueue(butlerData);
  const store = new SessionBindingStore(
    join(butlerData, "runtime", "sessions.sqlite"),
    "ephemeral",
  );
  const sessionId = "butler/app-final-crash";
  try {
    store.upsert({
      sessionId,
      role: "butler",
      workspacePath: butlerData,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.6-sol",
      transportBindings: [{ transport: "app", accountId: "local", peerId: "final-crash" }],
    });
    queue.enqueue({
      eventId: "app:final-crash",
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: "final-crash" },
      sender: { id: "app-user" },
      message: { id: "message-final-crash", text: "finish", timestamp: "2026-08-13T00:00:00.000Z" },
      routingHints: { sessionId, turnId: "turn-final-crash" },
    });
    const server = {
      async handleInbound() {
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
            metadata: {
              text: "durable final",
              turnId: "turn-final-crash",
              canonicalMessageId: "canonical-final-crash",
            },
          },
        };
      },
    };
    const originalComplete = queue.complete.bind(queue);
    let crashBoundary = true;
    queue.complete = ((...args: Parameters<NativeInboundQueue["complete"]>) => {
      if (crashBoundary) {
        crashBoundary = false;
        return false;
      }
      return originalComplete(...args);
    }) as NativeInboundQueue["complete"];
    const first = new BtccInboundDispatcher();
    first.poll({
      queue,
      store,
      server,
      processingLeaseMs: 1,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
      deliveryGuard: new DeliveryGuard({
        adapters: [createAppTransportAdapter()],
        butlerData,
      }),
    });
    await first.waitForIdle();
    expect(readTranscript(sessionId, butlerData).filter((event) =>
      event.kind === "outbound",
    )).toHaveLength(1);

    const replay = new BtccInboundDispatcher();
    replay.poll({
      queue,
      store,
      server,
      processingLeaseMs: 1,
      now: () => new Date("2026-08-13T00:00:01.000Z"),
      deliveryGuard: new DeliveryGuard({
        adapters: [createAppTransportAdapter()],
        butlerData,
      }),
    });
    await replay.waitForIdle();
    const actions = readTranscript(sessionId, butlerData)
      .filter((event) => event.kind === "outbound")
      .map((event) => event.payload.actionId);
    expect(actions).toEqual([actions[0], actions[0]]);
    expect(queue.claim(1)).toEqual([]);
  } finally {
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("a cancelling App Turn still enters the single BTCC path", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-cancelled-ingress-"));
  const queue = new NativeInboundQueue(butlerData);
  const store = new SessionBindingStore(
    join(butlerData, "runtime", "sessions.sqlite"),
    "ephemeral",
  );
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
      server: {
        async handleInbound() {
          handled = true;
          return {
            status: "handled" as const,
            route: {
              sessionId: "butler/app-general",
              role: "butler" as const,
              reason: "session-hint" as const,
              workspacePath: butlerData,
            },
            handlerResult: {
              ok: true,
              metadata: { text: "BTCC observed cancellation" },
            },
          };
        },
      },
    });
    await dispatcher.waitForIdle();

    expect(summary.claimed).toBe(1);
    expect(summary.handled).toBe(1);
    expect(handled).toBe(true);
  } finally {
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("a BTCC runtime interruption parks the exact queue item for process replacement", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-runtime-interruption-"));
  const queue = new NativeInboundQueue(butlerData);
  const store = new SessionBindingStore(
    join(butlerData, "runtime", "sessions.sqlite"),
    "ephemeral",
  );
  try {
    const queued = queue.enqueue({
      eventId: "app:runtime-interruption",
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: "general" },
      sender: { id: "app-user" },
      message: {
        id: "runtime-interruption",
        text: "preserve this exact Turn",
        timestamp: "2026-07-28T00:00:00.000Z",
      },
      routingHints: {
        sessionId: "butler/app-general",
        turnId: "turn-runtime-interruption",
      },
    });
    const dispatcher = new BtccInboundDispatcher();
    const summary = dispatcher.poll({
      queue,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      server: {
        async handleInbound() {
          throw new Error("post-commit activation interrupted");
        },
      },
    });
    await dispatcher.waitForIdle();

    expect(summary).toEqual({
      claimed: 1,
      handled: 0,
      delivered: 0,
      failed: 0,
      interrupted: 1,
    });
    const pending = join(
      butlerData,
      "runtime",
      "inbound-events",
      "pending",
      `${queued.queueId}.json`,
    );
    const failed = join(
      butlerData,
      "runtime",
      "inbound-events",
      "failed",
      `${queued.queueId}.json`,
    );
    expect(existsSync(pending)).toBe(true);
    expect(existsSync(failed)).toBe(false);
    expect(queue.claim(1)).toEqual([]);
    expect(readFileSync(pending, "utf8")).toContain('"dispatchStatus": "runtime-interrupted"');
  } finally {
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("a recovered runtime interruption resumes its admitted Turn", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-runtime-resume-"));
  const queue = new NativeInboundQueue(butlerData);
  const store = new SessionBindingStore(
    join(butlerData, "runtime", "sessions.sqlite"),
    "ephemeral",
  );
  try {
    queue.enqueue({
      eventId: "app:runtime-resume",
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: "general" },
      sender: { id: "app-user" },
      message: {
        id: "runtime-resume",
        text: "resume the admitted Turn",
        timestamp: "2026-07-28T00:00:00.000Z",
      },
      routingHints: {
        sessionId: "butler/app-general",
        turnId: "turn-runtime-resume",
      },
    });
    const [interrupted] = queue.claim(1);
    queue.fail(interrupted!, "runtime defect", { dispatchStatus: "runtime-interrupted" });
    expect(queue.recoverRuntimeInterruptions(() => true).requeued).toBe(1);

    let resumeMarker = false;
    const dispatcher = new BtccInboundDispatcher();
    dispatcher.poll({
      queue,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      server: {
        async handleInbound(envelope) {
          const raw = envelope.raw && typeof envelope.raw === "object" && !Array.isArray(envelope.raw)
            ? envelope.raw as Record<string, unknown>
            : {};
          resumeMarker = Object.keys(raw).some((key) => key.toLowerCase().includes("resume"));
          return {
            status: "handled",
            route: {
              sessionId: "butler/app-general",
              role: "butler",
              reason: "session-hint",
              workspacePath: butlerData,
            },
            handlerResult: { ok: true, handledBy: "btcc-turn-runtime" },
          };
        },
      },
    });
    await dispatcher.waitForIdle();

    expect(resumeMarker).toBe(false);
  } finally {
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});
