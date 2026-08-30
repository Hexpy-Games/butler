/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { createProductionBtccComposition } from "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import { createBtccGatewayHandlers } from "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { BtccInboundDispatcher } from "../../packages/butler-agent/src/interfaces/gateway/btcc/btcc-inbound-dispatcher.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { createNativeButlerProgressPublisher } from "../../packages/butler-agent/src/interfaces/gateway/native-butler/projection-and-lifecycle.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { sessionHintForRow } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import {
  FileQueueButlerServiceClient,
  type ButlerServiceClient,
} from "../../packages/butler-agent/src/gateways/core/client.ts";
import type { ModelRoundPort } from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { ModelRouteRecoveredFailureError } from "../../packages/butler-agent/src/agent/btcc/model-route/contracts.ts";
import { migrateAppStoreSchema } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("two live App compositions sharing a database do not steal an unexpired claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-live-sibling-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  let releaseResponder: (() => void) | undefined;
  let responderStarted: (() => void) | undefined;
  const responderStartedPromise = new Promise<void>((resolve) => {
    responderStarted = resolve;
  });
  const serverA = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => {
      responderStarted?.();
      return await new Promise<{ texts: string[] }>((resolve) => {
        releaseResponder = () => resolve({ texts: ["live owner answer"] });
      });
    },
  });
  let serverB: ReturnType<typeof createTestAppServer> | undefined;
  try {
    const requestA = postWithResponse(`${serverA.url}messages`, {
      chat_id: "general",
      text: "keep the live owner claim",
      client_message_id: "client-70707070-7070-4070-8070-707070707070",
    });
    await responderStartedPromise;
    const before = serverA.store.db.query<{
      claim_id: string | null;
      claim_owner: string | null;
      lease_expires_at: string | null;
    }, [string]>(`
      SELECT claim_id, claim_owner, lease_expires_at
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get("client-70707070-7070-4070-8070-707070707070");
    expect(before?.claim_id).toBeString();
    expect(before?.claim_owner).toMatch(/^app-session-queue:/u);
    expect(new Date(before!.lease_expires_at!).getTime()).toBeGreaterThan(Date.now());

    serverB = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
      responder: async () => ({ texts: ["wrong sibling answer"] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = serverA.store.db.query<{
      state: string;
      claim_id: string | null;
      claim_owner: string | null;
    }, [string]>(`
      SELECT state, claim_id, claim_owner
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get("client-70707070-7070-4070-8070-707070707070");
    expect(after).toEqual({
      state: "dispatching",
      claim_id: before!.claim_id,
      claim_owner: before!.claim_owner,
    });

    releaseResponder?.();
    const accepted = await requestA;
    expect(accepted.response.status).toBe(202);
    await waitForQueueState(
      dbPath,
      "client-70707070-7070-4070-8070-707070707070",
      "dispatched",
    );
  } finally {
    releaseResponder?.();
    serverB?.stop();
    serverA.stop();
  }
});

test("a preserved sibling claim wakes the live dispatcher when its owner stops", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-sibling-wake-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-sibling-wake",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("replacement owner answer"),
  });
  let responderStarted: (() => void) | undefined;
  const responderStartedPromise = new Promise<void>((resolve) => {
    responderStarted = resolve;
  });
  let serverA: ReturnType<typeof createTestAppServer> | undefined = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => {
      responderStarted?.();
      return await new Promise<{ texts: string[] }>(() => undefined);
    },
  });
  let serverB: ReturnType<typeof createTestAppServer> | undefined;
  const clientMessageId = "client-90909090-9090-4090-8090-909090909090";
  try {
    const pending = postWithResponse(`${serverA.url}messages`, {
      chat_id: "general",
      text: "wake the preserved sibling claim",
      client_message_id: clientMessageId,
    }).catch(() => undefined);
    await responderStartedPromise;
    const before = serverA.store.db.query<{
      claim_id: string | null;
      claim_owner: string | null;
      lease_expires_at: string | null;
    }, [string]>(`
      SELECT claim_id, claim_owner, lease_expires_at
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    expect(before?.claim_id).toBeString();
    expect(before?.claim_owner).toMatch(/^app-session-queue:/u);
    expect(Date.parse(before!.lease_expires_at!)).toBeGreaterThan(Date.now());

    serverB = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(serverA.store.db.query<{
      state: string;
      claim_id: string | null;
      claim_owner: string | null;
    }, [string]>(`
      SELECT state, claim_id, claim_owner
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId)).toEqual({
      state: "dispatching",
      claim_id: before!.claim_id,
      claim_owner: before!.claim_owner,
    });

    serverA.stop();
    serverA = undefined;
    void pending;
    const queue = new NativeInboundQueue(root);
    const inbound = new BtccInboundDispatcher();
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindings }),
      handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
      butlerData: root,
    });
    const deliveryGuard = new DeliveryGuard({
      adapters: [createAppTransportAdapter()],
      butlerData: root,
    });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      inbound.poll({
        queue,
        server: gateway,
        store: bindings,
        deliveryGuard,
        limit: 4,
        maxConcurrentSessions: 1,
      });
      await inbound.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await serverB.store.waitForAppTransportProjection();
      while (serverB.store.syncNextAppTransportBatch()) {
        // Re-enter the canonical production responder and projection path.
      }
      const state = serverB.store.db.query<{ state: string }, [string]>(`
        SELECT state FROM session_queued_messages
        WHERE client_message_id = ?
      `).get(clientMessageId);
      if (state?.state === "dispatched") break;
    }
    await waitForQueueState(dbPath, clientMessageId, "dispatched");
    expect(serverB.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM messages
      WHERE role = 'assistant' AND turn_id = (
        SELECT turn_id FROM session_queued_messages WHERE client_message_id = ?
      )
    `).get(clientMessageId)?.count).toBe(1);
  } finally {
    serverB?.stop();
    serverA?.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("a stopped same-process App owner is reclaimed without a new input", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-stopped-owner-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  let responderStarted: (() => void) | undefined;
  const responderStartedPromise = new Promise<void>((resolve) => {
    responderStarted = resolve;
  });
  let serverA: ReturnType<typeof createTestAppServer> | undefined = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => {
      responderStarted?.();
      return await new Promise<{ texts: string[] }>(() => undefined);
    },
  });
  let serverB: ReturnType<typeof createTestAppServer> | undefined;
  let bindings: SessionBindingStore | undefined;
  let composition: ReturnType<typeof createProductionBtccComposition> | undefined;
  const clientMessageId = "client-76767676-7676-4676-8676-767676767676";
  try {
    const pending = postWithResponse(`${serverA.url}messages`, {
      chat_id: "general",
      text: "recover a stopped same-process owner",
      client_message_id: clientMessageId,
    }).catch(() => undefined);
    await responderStartedPromise;
    const before = serverA.store.db.query<{
      state: string;
      claim_owner: string | null;
      lease_expires_at: string | null;
    }, [string]>(`
      SELECT state, claim_owner, lease_expires_at
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    expect(before).toMatchObject({ state: "dispatching" });
    expect(before?.claim_owner).toMatch(/^app-session-queue:/u);
    expect(Date.parse(before!.lease_expires_at!)).toBeGreaterThan(Date.now());

    serverA.stop();
    serverA = undefined;
    // The stopped owner must not be allowed to complete the old request after
    // its database connection has been closed.  The fetch is intentionally
    // left abandoned while the replacement owner drains the durable row.
    void pending;

    publishNativeReadiness(root);
    bindings = new SessionBindingStore(
      join(root, "runtime", "session-store.sqlite"),
      "ephemeral",
    );
    bindings.upsert({
      sessionId: sessionHintForRow("general"),
      role: "butler",
      workspacePath: root,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.5",
      transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
    });
    composition = createProductionBtccComposition({
      butlerHome: root,
      butlerData: root,
      ownerId: "queued-input-stopped-owner",
      sessionBindings: bindings,
      modelRound: oneRoundAnswer("recovered stopped owner"),
    });
    serverB = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
    });
    const queue = new NativeInboundQueue(root);
    const inbound = new BtccInboundDispatcher();
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindings }),
      handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
      butlerData: root,
    });
    const deliveryGuard = new DeliveryGuard({
      adapters: [createAppTransportAdapter()],
      butlerData: root,
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      inbound.poll({
        queue,
        server: gateway,
        store: bindings,
        deliveryGuard,
        limit: 4,
        maxConcurrentSessions: 1,
      });
      await inbound.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await serverB.store.waitForAppTransportProjection();
      while (serverB.store.syncNextAppTransportBatch()) {
        // Drain the bounded production projection batch.
      }
      const state = new Database(dbPath, { readonly: true });
      try {
        if (state.query<{ state: string }, [string]>(`
          SELECT state FROM session_queued_messages
          WHERE client_message_id = ?
        `).get(clientMessageId)?.state === "dispatched") break;
      } finally {
        state.close();
      }
    }
    await waitForQueueState(dbPath, clientMessageId, "dispatched");
    const after = new Database(dbPath, { readonly: true });
    try {
      expect(after.query<{
        state: string;
        claim_id: string | null;
        claim_owner: string | null;
      }, [string]>(`
        SELECT state, claim_id, claim_owner
        FROM session_queued_messages
        WHERE client_message_id = ?
      `).get(clientMessageId)).toEqual({
        state: "dispatched",
        claim_id: null,
        claim_owner: null,
      });
    } finally {
      after.close();
    }
  } finally {
    serverB?.stop();
    serverA?.stop();
    await composition?.host.close();
    bindings?.close();
    clearNativeReadiness(root);
  }
});

test("a real child-process loss is reclaimed before the durable lease deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-child-recovery-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  const appServerModule = join(
    process.cwd(),
    "packages/butler-agent/src/test-support/app-server.ts",
  );
  const childSource = `
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(${JSON.stringify(join(root, "state"))}, { recursive: true });
    writeFileSync(
      ${JSON.stringify(join(root, "state", "butler-main-native.json"))},
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), runtime: "test-native-butler", launcher: "test" }),
    );
    const { createTestAppServer } = await import(${JSON.stringify(appServerModule)});
    const server = createTestAppServer({
      dbPath: ${JSON.stringify(dbPath)},
      butlerData: ${JSON.stringify(root)},
      port: 0,
    });
    process.stdout.write(server.url + "\\n");
    setInterval(() => undefined, 1000);
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let relaunched: ReturnType<typeof createTestAppServer> | undefined;
  let bindings: SessionBindingStore | undefined;
  let composition: ReturnType<typeof createProductionBtccComposition> | undefined;
  try {
    const childUrl = await firstLine(child.stdout);
    const clientMessageId = "client-73737373-7373-4373-8373-737373737373";
    const pending = postWithResponse(`${childUrl}messages`, {
      chat_id: "general",
      text: "recover after the child process dies",
      client_message_id: clientMessageId,
    }).catch(() => undefined);
    await waitForQueueState(dbPath, clientMessageId, "dispatching");
    const before = new Database(dbPath, { readonly: true });
    let childOwner: string | null;
    try {
      childOwner = before.query<{ claim_owner: string | null }, [string]>(`
        SELECT claim_owner FROM session_queued_messages
        WHERE client_message_id = ?
      `).get(clientMessageId)?.claim_owner ?? null;
    } finally {
      before.close();
    }
    expect(childOwner).toMatch(new RegExp(`^app-session-queue:${child.pid}:`, "u"));
    process.kill(child.pid, "SIGKILL");
    await child.exited;
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 100));

    publishNativeReadiness(root);
    bindings = new SessionBindingStore(
      join(root, "runtime", "session-store.sqlite"),
      "ephemeral",
    );
    bindings.upsert({
      sessionId: sessionHintForRow("general"),
      role: "butler",
      workspacePath: root,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.5",
      transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
    });
    composition = createProductionBtccComposition({
      butlerHome: root,
      butlerData: root,
      ownerId: "queued-input-child-recovery",
      sessionBindings: bindings,
      modelRound: oneRoundAnswer("child recovery answer"),
    });
    relaunched = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
    });
    await waitForQueueState(dbPath, clientMessageId, "dispatching");
    const queue = new NativeInboundQueue(root);
    expect(readdirSync(join(queue.rootDir, "pending"), { withFileTypes: true }).map((entry) => entry.name)).not.toHaveLength(0);
    const inbound = new BtccInboundDispatcher();
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindings }),
      handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
      butlerData: root,
    });
    let claimed = 0;
    let delivered = 0;
    let interrupted = 0;
    const deliveryGuard = new DeliveryGuard({
      adapters: [createAppTransportAdapter()],
      butlerData: root,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const summary = inbound.poll({
        queue,
        server: gateway,
        store: bindings,
        deliveryGuard,
        limit: 4,
        maxConcurrentSessions: 1,
      });
      await inbound.waitForIdle();
      claimed += summary.claimed;
      delivered += summary.delivered;
      interrupted += summary.interrupted;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await relaunched.store.waitForAppTransportProjection();
      while (relaunched.store.syncNextAppTransportBatch()) {
        // Drain the bounded projection batch before checking durable state.
      }
      const state = new Database(dbPath, { readonly: true });
      try {
        if (state.query<{ state: string }, [string]>(`
          SELECT state FROM session_queued_messages
          WHERE client_message_id = ?
        `).get(clientMessageId)?.state === "dispatched") break;
      } finally {
        state.close();
      }
    }
    expect(claimed).toBeGreaterThanOrEqual(1);
    expect(delivered).toBeGreaterThanOrEqual(1);
    expect(interrupted).toBe(0);
    await waitForQueueState(dbPath, clientMessageId, "dispatched");
    const after = new Database(dbPath, { readonly: true });
    try {
      const row = after.query<{
        state: string;
        claim_owner: string | null;
        lease_expires_at: string | null;
      }, [string]>(`
        SELECT state, claim_owner, lease_expires_at
        FROM session_queued_messages
        WHERE client_message_id = ?
      `).get(clientMessageId);
      expect(row?.state).toBe("dispatched");
      expect(row?.claim_owner).not.toBe(childOwner);
      expect(row?.claim_owner).toBeNull();
      expect(row?.lease_expires_at).toBeNull();
    } finally {
      after.close();
    }
    const visible = await getJson(`${relaunched.url}messages?chat_id=general&cursor=0`);
    expect(visible.data.messages.filter((message: { role?: string }) =>
      message.role === "assistant",
    )).toHaveLength(1);
  } finally {
    relaunched?.stop();
    await composition?.host.close();
    bindings?.close();
    clearNativeReadiness(root);
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {}
    await child.exited.catch(() => undefined);
  }
});

test("a stale App handoff cannot terminalize a replacement claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-handoff-fence-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-handoff-fence",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("replayed handoff answer"),
  });
  const delegate = new FileQueueButlerServiceClient({ butlerData: root });
  let replacedClaim: string | undefined;
  let injected = false;
  const serviceClient: ButlerServiceClient = {
    findAppTurn() {
      return null;
    },
    enqueueAppTurn(input, metadata) {
      if (!injected) {
        injected = true;
        const row = server!.store.db.query<{
          id: string;
          claim_id: string | null;
        }, [string, string]>(`
          SELECT id, claim_id
          FROM session_queued_messages
          WHERE chat_id = ? AND turn_id = ?
        `).get(input.chatId, input.turnId);
        expect(row?.claim_id).toBeString();
        const internal = queueInternals(server!.store);
        server!.store.db.query(`
          UPDATE session_queued_messages
          SET lease_expires_at = ?
          WHERE id = ?
        `).run(new Date(Date.now() - 1_000).toISOString(), row!.id);
        expect(internal.kernel.sessionQueue.recoverExpiredDispatches(
          input.chatId,
          new Date(),
        )).toBe(1);
        replacedClaim = `app-session-queue:${process.pid}:replacement:${crypto.randomUUID()}`;
        expect(internal.kernel.sessionQueue.claimDispatch(
          input.chatId,
          row!.id,
          replacedClaim,
          replacedClaim,
        )).toMatchObject({ claim_id: replacedClaim, state: "dispatching" });
        throw new Error("handoff failed after claim replacement");
      }
      return delegate.enqueueAppTurn(input, metadata);
    },
    enqueueAppCancellation(input, metadata) {
      return delegate.enqueueAppCancellation(input, metadata);
    },
    enqueueAppResume(input, metadata) {
      return delegate.enqueueAppResume(input, metadata);
    },
  };
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    serviceClient,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const body = {
    chat_id: "general",
    text: "fence a stale App-to-Native handoff",
    model: "openai/gpt-5.5",
    reasoning_effort: "low",
    client_message_id: "client-78787878-7878-4787-8787-787878787878",
  };
  try {
    const first = await postWithResponse(`${server.url}messages`, body);
    expect(first.response.status).toBe(202);
    const row = server.store.db.query<{
      state: string;
      claim_id: string | null;
      turn_id: string | null;
      safe_error_code: string | null;
    }, [string]>(`
      SELECT state, claim_id, turn_id, safe_error_code
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(body.client_message_id);
    expect(row).toMatchObject({
      state: "dispatching",
      claim_id: replacedClaim,
      safe_error_code: null,
    });
    expect(row?.turn_id).toBeString();
    expect(server.store.db.query<{ state: string; safe_error_code: string | null }, [string]>(`
      SELECT state, safe_error_code FROM turns WHERE id = ?
    `).get(row!.turn_id!)).toEqual({ state: "thinking", safe_error_code: null });
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM events
      WHERE type IN ('turn.queue_failed', 'turn.failed')
        AND json_extract(payload_json, '$.turn_id') = ?
    `).get(row!.turn_id!)?.count).toBe(0);

    // The replacement owner remains dispatching until its bounded lease is
    // recovered; the public replay then re-enters the canonical drain path.
    server.store.db.query(`
      UPDATE session_queued_messages
      SET lease_expires_at = ?
      WHERE client_message_id = ?
    `).run(new Date(Date.now() - 1_000).toISOString(), body.client_message_id);
    const replay = await postWithResponse(`${server.url}messages`, body);
    expect(replay.response.status).toBe(202);
    expect(readdirSync(join(root, "runtime", "inbound-events", "pending"), {
      withFileTypes: true,
    })).not.toHaveLength(0);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const summary = inbound.poll({
        queue,
        server: gateway,
        store: bindings,
        deliveryGuard,
        limit: 4,
        maxConcurrentSessions: 1,
      });
      await inbound.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await server.store.waitForAppTransportProjection();
      while (server.store.syncNextAppTransportBatch()) {
        // Drain the production projection before checking replay settlement.
      }
      if (summary.delivered > 0) break;
    }
    await waitForQueueState(dbPath, body.client_message_id, "dispatched");
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "assistant",
    )).toHaveLength(1);
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "user",
    )).toHaveLength(1);
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("a post-enqueue exception keeps the durable Native event recoverable", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-post-enqueue-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-post-enqueue",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("post-enqueue recovery answer"),
  });
  const delegate = new FileQueueButlerServiceClient({ butlerData: root });
  let enqueueCalls = 0;
  const serviceClient: ButlerServiceClient = {
    findAppTurn(input) {
      return delegate.findAppTurn(input);
    },
    enqueueAppTurn(input, metadata) {
      enqueueCalls += 1;
      const queued = delegate.enqueueAppTurn(input, metadata);
      void queued;
      throw new Error("post-enqueue bookkeeping boundary");
    },
    enqueueAppCancellation(input, metadata) {
      return delegate.enqueueAppCancellation(input, metadata);
    },
    enqueueAppResume(input, metadata) {
      return delegate.enqueueAppResume(input, metadata);
    },
  };
  let server: ReturnType<typeof createTestAppServer> | undefined = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    serviceClient,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const body = {
    chat_id: "general",
    text: "recover a committed Native enqueue",
    model: "openai/gpt-5.5",
    reasoning_effort: "low",
    client_message_id: "client-89898989-8989-4989-8989-898989898989",
  };
  try {
    const accepted = await postWithResponse(`${server.url}messages`, body);
    expect(accepted.response.status).toBe(202);
    expect(enqueueCalls).toBe(1);
    const beforeRestart = server.store.db.query<{
      state: string;
      claim_id: string | null;
      turn_id: string | null;
      safe_error_code: string | null;
    }, [string]>(`
      SELECT state, claim_id, turn_id, safe_error_code
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(body.client_message_id);
    expect(beforeRestart).toMatchObject({
      state: "dispatching",
      safe_error_code: null,
    });
    expect(beforeRestart?.claim_id).toBeString();
    expect(beforeRestart?.turn_id).toBeString();
    expect(server.store.getTurn(beforeRestart!.turn_id!)).toMatchObject({
      state: "thinking",
      safe_error_code: undefined,
    });
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM events
      WHERE type IN ('turn.queue_failed', 'turn.failed')
        AND json_extract(payload_json, '$.turn_id') = ?
    `).get(beforeRestart!.turn_id!)?.count).toBe(0);

    server.stop();
    server = undefined;
    server = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
      serviceClient: delegate,
    });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      inbound.poll({
        queue,
        server: gateway,
        store: bindings,
        deliveryGuard,
        limit: 4,
        maxConcurrentSessions: 1,
      });
      await inbound.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await server.store.waitForAppTransportProjection();
      while (server.store.syncNextAppTransportBatch()) {
        // Drain the canonical production transcript/recovery path.
      }
      const state = server.store.db.query<{ state: string }, [string]>(`
        SELECT state FROM session_queued_messages
        WHERE client_message_id = ?
      `).get(body.client_message_id);
      if (state?.state === "dispatched") break;
    }
    await waitForQueueState(dbPath, body.client_message_id, "dispatched");
    const visible = await getJson(`${server.url}messages?chat_id=general&cursor=0`);
    expect(visible.data.messages.filter((message: { role?: string }) =>
      message.role === "assistant",
    )).toHaveLength(1);
    expect(server.store.getTurn(beforeRestart!.turn_id!)).toMatchObject({
      state: "delivered",
    });
  } finally {
    server?.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("a production stale final cannot project after claim reclaim and replay settles the current claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-stale-final-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  let releaseOld: (() => void) | undefined;
  let oldStarted: (() => void) | undefined;
  const oldStartedPromise = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  let calls = 0;
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-stale-final",
    sessionBindings: bindings,
    modelRound: {
      async runRound() {
        calls += 1;
        if (calls === 1) {
          oldStarted?.();
          return await new Promise<{ text: string; toolCalls: [] }>((resolve) => {
            releaseOld = () => resolve({ text: "old stale answer", toolCalls: [] });
          });
        }
        return { text: "old stale answer", toolCalls: [] };
      },
    },
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  try {
    const body = {
      chat_id: "general",
      text: "reclaim before the old final arrives",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      client_message_id: "client-74747474-7474-4474-8474-747474747474",
    };
    const accepted = await postWithResponse(`${server.url}messages`, body);
    expect(accepted.response.status).toBe(202);
    const firstPoll = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await oldStartedPromise;
    expect(firstPoll.claimed).toBe(1);
    const before = server.store.db.query<{
      id: string;
      claim_id: string | null;
      turn_id: string | null;
      state: string;
    }, [string]>(`
      SELECT id, claim_id, turn_id, state
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(body.client_message_id);
    expect(before).toMatchObject({ state: "dispatching" });
    expect(before?.claim_id).toBeString();
    expect(before?.turn_id).toBeString();

    const internals = queueInternals(server.store);
    expect(internals.kernel.sessionQueue.recoverExpiredDispatches(
      "general",
      new Date(Date.now() + 61_000),
    )).toBe(1);
    const replay = await postWithResponse(`${server.url}messages`, body);
    expect(replay.response.status).toBe(202);
    await waitForQueueState(dbPath, body.client_message_id, "dispatching");
    const current = server.store.db.query<{ claim_id: string | null }, [string]>(`
      SELECT claim_id FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(body.client_message_id);
    expect(current?.claim_id).toBeString();
    expect(current?.claim_id).not.toBe(before?.claim_id);

    releaseOld?.();
    await inbound.waitForIdle();
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the stale-final projection batch before asserting no mutation.
    }
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "assistant",
    )).toHaveLength(0);

    const secondPoll = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    expect(secondPoll.claimed).toBeGreaterThanOrEqual(1);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the replay projection batch before asserting settlement.
    }
    await waitForQueueState(dbPath, body.client_message_id, "dispatched");
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "assistant",
    )).toHaveLength(1);
  } finally {
    releaseOld?.();
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("a stale production runtime fault cannot project after claim reclaim", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-stale-runtime-fault-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  let modelRoundCalls = 0;
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-stale-runtime-fault",
    sessionBindings: bindings,
    modelRound: {
      async runRound() {
        modelRoundCalls += 1;
        throw new ModelRouteRecoveredFailureError("synthetic_runtime_fault", "retry");
      },
    },
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  try {
    const body = {
      chat_id: "general",
      text: "reclaim before a stale runtime fault arrives",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      client_message_id: "client-75757575-7575-4575-8575-757575757575",
    };
    const accepted = await postWithResponse(`${server.url}messages`, body);
    expect(accepted.response.status).toBe(202);
    const firstPoll = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    expect(firstPoll.claimed).toBe(1);
    expect(firstPoll.interrupted).toBe(1);
    expect(modelRoundCalls).toBeGreaterThan(0);
    const before = server.store.db.query<{
      id: string;
      claim_id: string | null;
      turn_id: string | null;
      state: string;
    }, [string]>(`
      SELECT id, claim_id, turn_id, state
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(body.client_message_id);
    expect(before).toMatchObject({ state: "dispatching" });
    expect(before?.claim_id).toBeString();
    expect(before?.turn_id).toBeString();

    const queueInternalsForRecovery = queueInternals(server.store);
    expect(queueInternalsForRecovery.kernel.sessionQueue.recoverExpiredDispatches(
      "general",
      new Date(Date.now() + 61_000),
    )).toBe(1);
    const replay = await postWithResponse(`${server.url}messages`, body);
    expect(replay.response.status).toBe(202);
    await waitForQueueState(dbPath, body.client_message_id, "dispatching");
    const current = server.store.db.query<{ claim_id: string | null }, [string]>(`
      SELECT claim_id FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(body.client_message_id);
    expect(current?.claim_id).toBeString();
    expect(current?.claim_id).not.toBe(before?.claim_id);

    const staleProgress = await composition.host.progress.reconcile(
      createNativeButlerProgressPublisher({
        deliver: (sessionId, action, metadata) =>
          deliveryGuard.deliver(sessionId, action, metadata),
      }),
    );
    expect(staleProgress.attempted).toBeGreaterThan(0);
    const runtimeFault = readdirSync(join(root, "transcripts"), { withFileTypes: true })
      .flatMap((entry) => readFileSync(join(root, "transcripts", entry.name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as {
          kind?: string;
          payload?: {
            metadata?: {
              kind?: string;
              appQueueClaimId?: string;
              event?: { kind?: string };
            };
          };
        }))
      .find((event) =>
        event.kind === "outbound" &&
        event.payload?.metadata?.kind === "turn_event" &&
        event.payload.metadata.event?.kind === "runtime.fault",
      );
    expect(runtimeFault?.payload?.metadata?.appQueueClaimId).toBe(before?.claim_id ?? undefined);
    expect(runtimeFault?.payload?.metadata?.appQueueClaimId).not.toBe(current?.claim_id ?? undefined);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the stale runtime-fault projection attempt before asserting no mutation.
    }
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "assistant",
    )).toHaveLength(0);
    expect(server.store.getTurn(before!.turn_id!)).toMatchObject({
      id: before!.turn_id,
      state: "thinking",
    });

    await composition.host.close();
    bindings.close();

    const compositionModule = join(
      process.cwd(),
      "packages/butler-agent/src/agent/composition/create-btcc-composition.ts",
    );
    const childSource = `
      const { NativeInboundQueue } = await import(${JSON.stringify(join(
        process.cwd(),
        "packages/butler-agent/src/gateways/core/inbound-queue.ts",
      ))});
      const { GatewayRouter } = await import(${JSON.stringify(join(
        process.cwd(),
        "packages/butler-agent/src/gateways/core/router.ts",
      ))});
      const { createGatewayServer } = await import(${JSON.stringify(join(
        process.cwd(),
        "packages/butler-agent/src/gateways/core/server.ts",
      ))});
      const { createProductionBtccComposition } = await import(${JSON.stringify(compositionModule)});
      const { createBtccGatewayHandlers } = await import(${JSON.stringify(join(
        process.cwd(),
        "packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts",
      ))});
      const { BtccInboundDispatcher } = await import(${JSON.stringify(join(
        process.cwd(),
        "packages/butler-agent/src/interfaces/gateway/btcc/btcc-inbound-dispatcher.ts",
      ))});
      const { DeliveryGuard } = await import(${JSON.stringify(join(
        process.cwd(),
        "packages/butler-agent/src/interfaces/transport/delivery-guard.ts",
      ))});
      const { createAppTransportAdapter } = await import(${JSON.stringify(join(
        process.cwd(),
        "packages/butler-agent/src/interfaces/transport/app/adapter.ts",
      ))});
      const { createNativeButlerProgressPublisher } = await import(${JSON.stringify(join(
        process.cwd(),
        "packages/butler-agent/src/interfaces/gateway/native-butler/projection-and-lifecycle.ts",
      ))});
      const { SessionBindingStore } = await import(${JSON.stringify(join(
        process.cwd(),
        "packages/butler-agent/src/test-support/harness/session-store.ts",
      ))});
      const bindings = new SessionBindingStore(${JSON.stringify(join(
        root,
        "runtime",
        "session-store.sqlite",
      ))}, "ephemeral");
      const composition = createProductionBtccComposition({
        butlerHome: ${JSON.stringify(root)},
        butlerData: ${JSON.stringify(root)},
        ownerId: "queued-input-stale-runtime-fault-replay",
        sessionBindings: bindings,
        modelRound: { async runRound() { return { text: "recovered after runtime fault", toolCalls: [] }; } },
      });
      const queue = new NativeInboundQueue(${JSON.stringify(root)});
      const inbound = new BtccInboundDispatcher();
      const deliveryGuard = new DeliveryGuard({
        adapters: [createAppTransportAdapter()],
        butlerData: ${JSON.stringify(root)},
      });
      const gateway = createGatewayServer({
        router: new GatewayRouter({ store: bindings }),
        handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
        butlerData: ${JSON.stringify(root)},
      });
      const summary = inbound.poll({
        queue,
        server: gateway,
        store: bindings,
        deliveryGuard,
        limit: 4,
        maxConcurrentSessions: 1,
      });
      await inbound.waitForIdle();
      await composition.host.progress.reconcile(
        createNativeButlerProgressPublisher({
          deliver: (sessionId, action, metadata) => deliveryGuard.deliver(sessionId, action, metadata),
        }),
      );
      await composition.host.close();
      bindings.close();
      process.stdout.write(JSON.stringify(summary));
    `;
    const child = Bun.spawn([process.execPath, "-e", childSource], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const childOutput = await new Response(child.stdout).text();
    await child.exited;
    expect(childOutput).toMatch(/"claimed":\s*1/u);
    expect(childOutput).toMatch(/"delivered":\s*\d+/u);
    await waitForQueueState(dbPath, body.client_message_id, "dispatched");
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the current-claim final projection before asserting settlement.
    }
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "assistant",
    )).toHaveLength(1);
  } finally {
    server.stop();
    await Promise.resolve(composition.host.close());
    try {
      bindings.close();
    } catch {}
    clearNativeReadiness(root);
  }
});

test("a stale cancellation acknowledgement is fenced after its advisory lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-cancel-race-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-cancel-race",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("cancel race should not answer"),
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const clientMessageId = "client-11111111-1111-4111-8111-111111111111";
  try {
    const accepted = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "cancel after the App claim is accepted",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      client_message_id: clientMessageId,
    });
    expect(accepted.response.status).toBe(202);
    const turnId = accepted.body.data?.turn?.id;
    const messageId = accepted.body.data?.accepted?.id;
    if (typeof turnId !== "string" || typeof messageId !== "string") {
      throw new Error("App response omitted input identity");
    }
    const cancel = await postWithResponse(
      `${server.url}turns/${encodeURIComponent(turnId)}/cancel`,
      {},
    );
    expect(cancel.response.status).toBe(202);
    expect(cancel.body.data?.turn).toMatchObject({ id: turnId, state: "cancelling" });
    const initial = server.store.db.query<{
      claim_id: string | null;
      state: string;
      turn_updated_at: string;
    }, [string]>(`
      SELECT queue.claim_id, queue.state, turns.updated_at AS turn_updated_at
      FROM session_queued_messages AS queue
      JOIN turns ON turns.id = queue.turn_id
      WHERE queue.client_message_id = ?
    `).get(clientMessageId);
    if (!initial) throw new Error("App queue admission was not persisted");
    const initialOutbox = server.store.db.query<{
      state: string;
      queue_id: string | null;
      dispatch_claim_id: string | null;
    }, [string]>(`
      SELECT state, queue_id, dispatch_claim_id
      FROM app_turn_cancel_outbox WHERE turn_id = ?
    `).get(turnId);
    if (!initialOutbox) throw new Error("Cancellation outbox was not persisted");
    expect(initialOutbox.state).toBe("pending");

    const sessionQueue = queueInternals(server.store).kernel.sessionQueue;
    queueInternals(server.store).kernel.sessionQueueDispatcher.close();
    const originalClaim = initial.claim_id ??
      `app-session-queue:${process.pid}:cancel-race-original:${crypto.randomUUID()}`;
    server.store.db.query(`
      UPDATE session_queued_messages
      SET state = 'queued', claim_id = NULL, claim_owner = NULL,
        claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE client_message_id = ?
    `).run(new Date().toISOString(), clientMessageId);
    const seeded = sessionQueue.claimDispatch(
      "general",
      server.store.db.query<{ id: string }, [string]>(`
        SELECT id FROM session_queued_messages WHERE client_message_id = ?
      `).get(clientMessageId)!.id,
      originalClaim,
      originalClaim,
    );
    if (!seeded) throw new Error("Failed to seed the accepted queue claim");
    expect(seeded.state).toBe("dispatching");
    const originalFence = sessionQueue.fenceQueuedTurnClaim.bind(sessionQueue);
    const replacementClaim = `app-session-queue:${process.pid}:cancel-race:${crypto.randomUUID()}`;
    let replaced = false;
    sessionQueue.fenceQueuedTurnClaim = (input) => {
      if (!replaced && input.claimId === originalClaim) {
        replaced = true;
        const now = new Date();
        server.store.db.query(`
          UPDATE session_queued_messages
          SET claim_id = ?, claim_owner = ?, claimed_at = ?,
            lease_expires_at = ?, updated_at = ?
          WHERE chat_id = ? AND turn_id = ? AND state = 'dispatching'
            AND claim_id = ?
        `).run(
          replacementClaim,
          replacementClaim,
          now.toISOString(),
          new Date(now.getTime() + 60_000).toISOString(),
          now.toISOString(),
          "general",
          turnId,
          originalClaim,
        );
      }
      return originalFence(input);
    };

    const actionId = "queued-input-cancel-race-ack";
    const timestamp = new Date().toISOString();
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp,
      payload: {
        actionId,
        message: { text: "", replyToMessageId: messageId },
        metadata: {
          kind: "turn_cancellation_ack",
          turnId,
          requestId: `cancel:${turnId}`,
          queueId: "cancel-race-queue",
          dispatchClaimId: "cancel-race-dispatch",
          appQueueClaimId: originalClaim,
          outcome: "cancelled",
        },
      },
    }), root);
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "delivery",
      transport: "app",
      timestamp,
      payload: { actionId, ok: true },
    }), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the production projection batch before inspecting the stale cut.
    }

    const stale = server.store.db.query<{
      staged: number;
      receipts: number;
      queueState: string;
      claimId: string | null;
      outboxState: string;
      outboxQueueId: string | null;
      outboxDispatchClaimId: string | null;
      turnState: string;
      turnUpdatedAt: string;
    }, [string, string, string, string]>(`
      SELECT
        (SELECT COUNT(*) FROM app_transport_projection_staged_outbounds WHERE action_id = ?) AS staged,
        (SELECT COUNT(*) FROM app_transport_projection_receipts WHERE action_id = ?) AS receipts,
        queue.state AS queueState, queue.claim_id AS claimId,
        outbox.state AS outboxState, outbox.queue_id AS outboxQueueId,
        outbox.dispatch_claim_id AS outboxDispatchClaimId,
        turns.state AS turnState, turns.updated_at AS turnUpdatedAt
      FROM session_queued_messages AS queue
      JOIN turns ON turns.id = queue.turn_id
      JOIN app_turn_cancel_outbox AS outbox ON outbox.turn_id = turns.id
      WHERE queue.client_message_id = ? AND turns.id = ?
    `).get(actionId, actionId, clientMessageId, turnId);
    expect(replaced).toBeTrue();
    expect(stale).toEqual({
      staged: 0,
      receipts: 0,
      queueState: "dispatching",
      claimId: replacementClaim,
      outboxState: initialOutbox.state,
      outboxQueueId: initialOutbox.queue_id,
      outboxDispatchClaimId: initialOutbox.dispatch_claim_id,
      turnState: "cancelling",
      turnUpdatedAt: initial.turn_updated_at,
    });

    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: {
        actionId,
        message: { text: "", replyToMessageId: messageId },
        metadata: {
          kind: "turn_cancellation_ack",
          turnId,
          requestId: `cancel:${turnId}`,
          queueId: "cancel-race-queue",
          dispatchClaimId: "cancel-race-dispatch",
          appQueueClaimId: replacementClaim,
          outcome: "cancelled",
        },
      },
    }), root);
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "delivery",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: { actionId, ok: true },
    }), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the current cancellation acknowledgement replay.
    }
    expect(server.store.db.query<{ state: string }, [string]>(`
      SELECT state FROM app_turn_cancel_outbox WHERE turn_id = ?
    `).get(turnId)?.state).toBe("accepted");
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM app_transport_projection_receipts
      WHERE action_id = ?
    `).get(actionId)?.count).toBe(1);

    const terminalActionId = "queued-input-cancel-race-terminal";
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: {
        actionId: terminalActionId,
        message: { text: "", replyToMessageId: messageId },
        metadata: {
          kind: "turn_event",
          turnId,
          appQueueClaimId: replacementClaim,
          event: { kind: "turn.cancelled" },
        },
      },
    }), root);
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "delivery",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: { actionId: terminalActionId, ok: true },
    }), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the current cancellation terminal replay.
    }
    expect(server.store.db.query<{
      queueState: string;
      safeErrorCode: string | null;
      turnState: string;
      outboxState: string;
    }, [string]>(`
      SELECT queue.state AS queueState, queue.safe_error_code AS safeErrorCode,
        turns.state AS turnState, outbox.state AS outboxState
      FROM session_queued_messages AS queue
      JOIN turns ON turns.id = queue.turn_id
      JOIN app_turn_cancel_outbox AS outbox ON outbox.turn_id = queue.turn_id
      WHERE queue.client_message_id = ?
    `).get(clientMessageId)).toEqual({
      queueState: "failed",
      safeErrorCode: "turn_cancelled",
      turnState: "cancelled",
      outboxState: "completed",
    });
    expect(server.store.listSessionQueue("general").queued_messages).not.toContainEqual(
      expect.objectContaining({ client_message_id: clientMessageId }),
    );
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM app_transport_projection_receipts
      WHERE action_id = ?
    `).get(terminalActionId)?.count).toBe(1);
    void queue;
    void inbound;
    void gateway;
    void deliveryGuard;
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("a stale progress row is fenced after its advisory lookup and current replay settles once", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-progress-race-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-progress-race",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("progress race answer"),
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const clientMessageId = "client-22222222-2222-4222-8222-222222222222";
  try {
    const accepted = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "project progress only while the claim is current",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      client_message_id: clientMessageId,
    });
    expect(accepted.response.status).toBe(202);
    const turnId = accepted.body.data?.turn?.id;
    const messageId = accepted.body.data?.accepted?.id;
    if (typeof turnId !== "string" || typeof messageId !== "string") {
      throw new Error("App response omitted input identity");
    }
    const initial = server.store.db.query<{
      claim_id: string | null;
      state: string;
      turn_state: string;
      turn_updated_at: string;
    }, [string]>(`
      SELECT queue.claim_id, queue.state, turns.state AS turn_state,
        turns.updated_at AS turn_updated_at
      FROM session_queued_messages AS queue
      JOIN turns ON turns.id = queue.turn_id
      WHERE queue.client_message_id = ?
    `).get(clientMessageId);
    if (!initial) throw new Error("App queue admission was not persisted");
    expect(initial.turn_state).toBe("thinking");

    const sessionQueue = queueInternals(server.store).kernel.sessionQueue;
    queueInternals(server.store).kernel.sessionQueueDispatcher.close();
    const originalClaim = initial.claim_id ??
      `app-session-queue:${process.pid}:progress-race-original:${crypto.randomUUID()}`;
    server.store.db.query(`
      UPDATE session_queued_messages
      SET state = 'queued', claim_id = NULL, claim_owner = NULL,
        claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE client_message_id = ?
    `).run(new Date().toISOString(), clientMessageId);
    const seeded = sessionQueue.claimDispatch(
      "general",
      server.store.db.query<{ id: string }, [string]>(`
        SELECT id FROM session_queued_messages WHERE client_message_id = ?
      `).get(clientMessageId)!.id,
      originalClaim,
      originalClaim,
    );
    if (!seeded) throw new Error("Failed to seed the accepted queue claim");
    expect(seeded.state).toBe("dispatching");
    const originalFence = sessionQueue.fenceQueuedTurnClaim.bind(sessionQueue);
    const replacementClaim = `app-session-queue:${process.pid}:progress-race:${crypto.randomUUID()}`;
    let replaced = false;
    sessionQueue.fenceQueuedTurnClaim = (input) => {
      if (!replaced && input.claimId === originalClaim) {
        replaced = true;
        const now = new Date();
        server.store.db.query(`
          UPDATE session_queued_messages
          SET claim_id = ?, claim_owner = ?, claimed_at = ?,
            lease_expires_at = ?, updated_at = ?
          WHERE chat_id = ? AND turn_id = ? AND state = 'dispatching'
            AND claim_id = ?
        `).run(
          replacementClaim,
          replacementClaim,
          now.toISOString(),
          new Date(now.getTime() + 60_000).toISOString(),
          now.toISOString(),
          "general",
          turnId,
          originalClaim,
        );
      }
      return originalFence(input);
    };

    const actionId = "queued-input-progress-race";
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: {
        actionId,
        message: { text: "Working", replyToMessageId: messageId },
        metadata: {
          kind: "tool_progress",
          turnId,
          appQueueClaimId: originalClaim,
          activityKind: "searched",
          toolName: "Search",
          safeLabel: "Search: stale progress race",
          inputLabel: "stale progress race",
          toolCallId: "progress-race-tool",
        },
      },
    }), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the production projection batch before inspecting the stale cut.
    }

    const stale = server.store.db.query<{
      progressRows: number;
      receipts: number;
      queueState: string;
      claimId: string | null;
      turnState: string;
      turnUpdatedAt: string;
    }, [string, string, string]>(`
      SELECT
        (SELECT COUNT(*) FROM events
          WHERE type = 'progress.summary' AND turn_id = turns.id) AS progressRows,
        (SELECT COUNT(*) FROM app_transport_projection_receipts WHERE action_id = ?) AS receipts,
        queue.state AS queueState, queue.claim_id AS claimId,
        turns.state AS turnState, turns.updated_at AS turnUpdatedAt
      FROM session_queued_messages AS queue
      JOIN turns ON turns.id = queue.turn_id
      WHERE queue.client_message_id = ? AND turns.id = ?
    `).get(actionId, clientMessageId, turnId);
    expect(replaced).toBeTrue();
    expect(stale).toEqual({
      progressRows: 0,
      receipts: 0,
      queueState: "dispatching",
      claimId: replacementClaim,
      turnState: "thinking",
      turnUpdatedAt: initial.turn_updated_at,
    });

    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: {
        actionId,
        message: { text: "Working", replyToMessageId: messageId },
        metadata: {
          kind: "tool_progress",
          turnId,
          appQueueClaimId: replacementClaim,
          activityKind: "searched",
          toolName: "Search",
          safeLabel: "Search: current progress replay",
          inputLabel: "current progress replay",
          toolCallId: "progress-race-tool",
        },
      },
    }), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the current progress replay.
    }
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM events
      WHERE type = 'progress.summary' AND turn_id = ?
    `).get(turnId)?.count).toBe(1);
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM app_transport_projection_receipts
      WHERE action_id = ?
    `).get(actionId)?.count).toBe(1);

    const finalActionId = "queued-input-progress-race-final";
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: {
        actionId: finalActionId,
        message: { text: "progress race answer", replyToMessageId: messageId },
        metadata: {
          kind: "final_result",
          turnId,
          appQueueClaimId: replacementClaim,
          canonicalMessageId: `assistant-${turnId}`,
          source: "btcc-inbound-dispatcher",
        },
      },
    }), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the current final replay before asserting settlement.
    }
    expect(server.store.db.query<{ state: string; claim_id: string | null }, [string]>(`
      SELECT state, claim_id FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId)).toEqual({ state: "dispatched", claim_id: null });
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM messages
      WHERE turn_id = ? AND role = 'assistant'
    `).get(turnId)?.count).toBe(1);
    expect(server.store.db.query<{ count: number }, [string, string]>(`
      SELECT COUNT(*) AS count FROM app_transport_projection_receipts
      WHERE action_id IN (?, ?)
    `).get(actionId, finalActionId)?.count).toBe(2);
    void queue;
    void inbound;
    void gateway;
    void deliveryGuard;
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("a stale runtime event stage is fenced after its advisory lookup and current replay settles once", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-runtime-stage-race-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-runtime-stage-race",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("runtime stage race answer"),
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const clientMessageId = "client-33333333-3333-4333-8333-333333333333";
  try {
    const accepted = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "fence a runtime event stage after claim replacement",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      client_message_id: clientMessageId,
    });
    expect(accepted.response.status).toBe(202);
    const turnId = accepted.body.data?.turn?.id;
    const messageId = accepted.body.data?.accepted?.id;
    if (typeof turnId !== "string" || typeof messageId !== "string") {
      throw new Error("App response omitted input identity");
    }
    const initial = server.store.db.query<{
      id: string;
      claim_id: string | null;
      state: string;
    }, [string]>(`
      SELECT id, claim_id, state
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    if (!initial) throw new Error("App queue admission was not persisted");
    expect(initial.state).toBe("dispatching");
    const sessionQueue = queueInternals(server.store).kernel.sessionQueue;
    queueInternals(server.store).kernel.sessionQueueDispatcher.close();
    const originalClaim = initial.claim_id ??
      `app-session-queue:${process.pid}:runtime-stage-original:${crypto.randomUUID()}`;
    server.store.db.query(`
      UPDATE session_queued_messages
      SET state = 'queued', claim_id = NULL, claim_owner = NULL,
        claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE client_message_id = ?
    `).run(new Date().toISOString(), clientMessageId);
    const seeded = sessionQueue.claimDispatch(
      "general",
      initial.id,
      originalClaim,
      originalClaim,
    );
    if (!seeded) throw new Error("Failed to seed the accepted queue claim");

    const replacementClaim = `app-session-queue:${process.pid}:runtime-stage-replacement:${crypto.randomUUID()}`;
    const originalClaimStatus = sessionQueue.queuedTurnClaimStatus.bind(sessionQueue);
    let replaced = false;
    sessionQueue.queuedTurnClaimStatus = (chatId, claimedTurnId, claimId) => {
      const status = originalClaimStatus(chatId, claimedTurnId, claimId);
      if (
        !replaced &&
        claimedTurnId === turnId &&
        claimId === originalClaim &&
        status === "current"
      ) {
        replaced = true;
        const now = new Date();
        server.store.db.query(`
          UPDATE session_queued_messages
          SET claim_id = ?, claim_owner = ?, claimed_at = ?,
            lease_expires_at = ?, updated_at = ?
          WHERE chat_id = ? AND turn_id = ? AND state = 'dispatching'
            AND claim_id = ?
        `).run(
          replacementClaim,
          replacementClaim,
          now.toISOString(),
          new Date(now.getTime() + 60_000).toISOString(),
          now.toISOString(),
          "general",
          turnId,
          originalClaim,
        );
      }
      return status;
    };

    const actionId = "queued-input-runtime-stage-race";
    const timestamp = new Date().toISOString();
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp,
      payload: {
        actionId,
        message: { text: "", replyToMessageId: messageId },
        metadata: {
          kind: "turn_event",
          turnId,
          appQueueClaimId: originalClaim,
          event: { kind: "turn.cancelled" },
        },
      },
    }), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the stale runtime-event staging attempt before inspecting it.
    }
    expect(replaced).toBeTrue();
    expect(server.store.db.query<{
      staged: number;
      receipts: number;
      queueState: string;
      claimId: string | null;
      turnState: string;
    }, [string, string, string, string]>(`
      SELECT
        (SELECT COUNT(*) FROM app_transport_projection_staged_outbounds WHERE action_id = ?) AS staged,
        (SELECT COUNT(*) FROM app_transport_projection_receipts WHERE action_id = ?) AS receipts,
        queue.state AS queueState, queue.claim_id AS claimId,
        turns.state AS turnState
      FROM session_queued_messages AS queue
      JOIN turns ON turns.id = queue.turn_id
      WHERE queue.client_message_id = ? AND turns.id = ?
    `).get(actionId, actionId, clientMessageId, turnId)).toEqual({
      staged: 0,
      receipts: 0,
      queueState: "dispatching",
      claimId: replacementClaim,
      turnState: "thinking",
    });

    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: {
        actionId,
        message: { text: "", replyToMessageId: messageId },
        metadata: {
          kind: "turn_event",
          turnId,
          appQueueClaimId: replacementClaim,
          event: { kind: "turn.cancelled" },
        },
      },
    }), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the current-claim runtime-event staging.
    }
    expect(server.store.db.query<{ staged: number }, [string]>(`
      SELECT COUNT(*) AS staged
      FROM app_transport_projection_staged_outbounds WHERE action_id = ?
    `).get(actionId)?.staged).toBe(1);

    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "delivery",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: { actionId, ok: true },
    }), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the delivered current-claim terminal event.
    }
    expect(server.store.db.query<{
      queueState: string;
      safeErrorCode: string | null;
      turnState: string;
      staged: number;
      receipts: number;
    }, [string, string, string]>(`
      SELECT
        queue.state AS queueState, queue.safe_error_code AS safeErrorCode,
        turns.state AS turnState,
        (SELECT COUNT(*) FROM app_transport_projection_staged_outbounds WHERE action_id = ?) AS staged,
        (SELECT COUNT(*) FROM app_transport_projection_receipts WHERE action_id = ?) AS receipts
      FROM session_queued_messages AS queue
      JOIN turns ON turns.id = queue.turn_id
      WHERE queue.client_message_id = ?
    `).get(actionId, actionId, clientMessageId)).toEqual({
      queueState: "failed",
      safeErrorCode: "turn_cancelled",
      turnState: "cancelled",
      staged: 0,
      receipts: 1,
    });
    void queue;
    void inbound;
    void gateway;
    void deliveryGuard;
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("a stale deferred final stage is fenced and current replay settles once", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-deferred-stage-race-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-deferred-stage-race",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("deferred final race answer"),
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const clientMessageId = "client-34343434-3434-4434-8434-343434343434";
  const queueId = "deferred-stage-race-queue";
  const dispatchClaimId = "deferred-stage-race-dispatch";
  try {
    const accepted = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "fence a deferred final stage after claim replacement",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      client_message_id: clientMessageId,
    });
    expect(accepted.response.status).toBe(202);
    const turnId = accepted.body.data?.turn?.id;
    const messageId = accepted.body.data?.accepted?.id;
    if (typeof turnId !== "string" || typeof messageId !== "string") {
      throw new Error("App response omitted input identity");
    }
    const initial = server.store.db.query<{
      id: string;
      claim_id: string | null;
      state: string;
    }, [string]>(`
      SELECT id, claim_id, state
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    if (!initial) throw new Error("App queue admission was not persisted");
    expect(initial.state).toBe("dispatching");
    const sessionQueue = queueInternals(server.store).kernel.sessionQueue;
    queueInternals(server.store).kernel.sessionQueueDispatcher.close();
    const originalClaim = initial.claim_id ??
      `app-session-queue:${process.pid}:deferred-stage-original:${crypto.randomUUID()}`;
    server.store.db.query(`
      UPDATE session_queued_messages
      SET state = 'queued', claim_id = NULL, claim_owner = NULL,
        claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE client_message_id = ?
    `).run(new Date().toISOString(), clientMessageId);
    const seeded = sessionQueue.claimDispatch(
      "general",
      initial.id,
      originalClaim,
      originalClaim,
    );
    if (!seeded) throw new Error("Failed to seed the accepted queue claim");
    const replacementClaim = `app-session-queue:${process.pid}:deferred-stage-replacement:${crypto.randomUUID()}`;
    const originalClaimStatus = sessionQueue.queuedTurnClaimStatus.bind(sessionQueue);
    let replaced = false;
    sessionQueue.queuedTurnClaimStatus = (chatId, claimedTurnId, claimId) => {
      const status = originalClaimStatus(chatId, claimedTurnId, claimId);
      if (
        !replaced &&
        claimedTurnId === turnId &&
        claimId === originalClaim &&
        status === "current"
      ) {
        replaced = true;
        const now = new Date();
        server.store.db.query(`
          UPDATE session_queued_messages
          SET claim_id = ?, claim_owner = ?, claimed_at = ?,
            lease_expires_at = ?, updated_at = ?
          WHERE chat_id = ? AND turn_id = ? AND state = 'dispatching'
            AND claim_id = ?
        `).run(
          replacementClaim,
          replacementClaim,
          now.toISOString(),
          new Date(now.getTime() + 60_000).toISOString(),
          now.toISOString(),
          "general",
          turnId,
          originalClaim,
        );
      }
      return status;
    };
    const actionId = "queued-input-deferred-stage-race";
    const finalEvent = (claimId: string) => createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: {
        actionId,
        message: { text: "deferred final race answer", replyToMessageId: messageId },
        metadata: {
          kind: "final_result",
          turnId,
          appQueueClaimId: claimId,
          queueId,
          dispatchClaimId,
          canonicalMessageId: `assistant-${turnId}`,
          source: "btcc-inbound-dispatcher",
        },
      },
    });
    appendTranscriptEvent(finalEvent(originalClaim), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Drain the stale deferred-final staging attempt before inspecting it.
    }
    expect(replaced).toBeTrue();
    expect(server.store.db.query<{
      staged: number;
      receipts: number;
      queueState: string;
      claimId: string | null;
    }, [string, string, string]>(`
      SELECT
        (SELECT COUNT(*) FROM app_transport_projection_staged_outbounds WHERE action_id = ?) AS staged,
        (SELECT COUNT(*) FROM app_transport_projection_receipts WHERE action_id = ?) AS receipts,
        state AS queueState, claim_id AS claimId
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(actionId, actionId, clientMessageId)).toEqual({
      staged: 0,
      receipts: 0,
      queueState: "dispatching",
      claimId: replacementClaim,
    });

    appendTranscriptEvent(finalEvent(replacementClaim), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // The current claim must stage the same action without identity conflict.
    }
    expect(server.store.db.query<{ staged: number }, [string]>(`
      SELECT COUNT(*) AS staged
      FROM app_transport_projection_staged_outbounds WHERE action_id = ?
    `).get(actionId)?.staged).toBe(1);

    mkdirSync(join(root, "runtime", "inbound-events", "processed"), { recursive: true });
    writeFileSync(
      join(root, "runtime", "inbound-events", "processed", `${queueId}.json`),
      JSON.stringify({ metadata: { terminalClaimId: dispatchClaimId } }),
      "utf8",
    );
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Reconcile the staged current-claim final after Native terminal commit.
    }
    expect(server.store.db.query<{
      queueState: string;
      claimId: string | null;
      turnState: string;
      staged: number;
      receipts: number;
      assistants: number;
    }, [string, string, string]>(`
      SELECT
        queue.state AS queueState, queue.claim_id AS claimId,
        turns.state AS turnState,
        (SELECT COUNT(*) FROM app_transport_projection_staged_outbounds WHERE action_id = ?) AS staged,
        (SELECT COUNT(*) FROM app_transport_projection_receipts WHERE action_id = ?) AS receipts,
        (SELECT COUNT(*) FROM messages WHERE turn_id = turns.id AND role = 'assistant') AS assistants
      FROM session_queued_messages AS queue
      JOIN turns ON turns.id = queue.turn_id
      WHERE queue.client_message_id = ?
    `).get(actionId, actionId, clientMessageId)).toEqual({
      queueState: "dispatched",
      claimId: null,
      turnState: "delivered",
      staged: 0,
      receipts: 1,
      assistants: 1,
    });
    void queue;
    void inbound;
    void gateway;
    void deliveryGuard;
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("a stale final cannot delete a current same-action staged row before claim fencing", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-staged-delete-race-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-staged-delete-race",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("staged delete race answer"),
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const clientMessageId = "client-35353535-3535-4535-8535-353535353535";
  const queueId = "staged-delete-race-queue";
  const dispatchClaimId = "staged-delete-race-dispatch";
  try {
    const accepted = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "preserve a staged final across a stale claimant",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      client_message_id: clientMessageId,
    });
    expect(accepted.response.status).toBe(202);
    const turnId = accepted.body.data?.turn?.id;
    const messageId = accepted.body.data?.accepted?.id;
    if (typeof turnId !== "string" || typeof messageId !== "string") {
      throw new Error("App response omitted input identity");
    }
    const initial = server.store.db.query<{
      id: string;
      claim_id: string | null;
      state: string;
    }, [string]>(`
      SELECT id, claim_id, state
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    if (!initial) throw new Error("App queue admission was not persisted");
    expect(initial.state).toBe("dispatching");
    const sessionQueue = queueInternals(server.store).kernel.sessionQueue;
    queueInternals(server.store).kernel.sessionQueueDispatcher.close();
    const originalClaim = initial.claim_id ??
      `app-session-queue:${process.pid}:staged-delete-original:${crypto.randomUUID()}`;
    server.store.db.query(`
      UPDATE session_queued_messages
      SET state = 'queued', claim_id = NULL, claim_owner = NULL,
        claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE client_message_id = ?
    `).run(new Date().toISOString(), clientMessageId);
    const seeded = sessionQueue.claimDispatch(
      "general",
      initial.id,
      originalClaim,
      originalClaim,
    );
    if (!seeded) throw new Error("Failed to seed the accepted queue claim");
    const actionId = "queued-input-staged-delete-race";
    const finalEvent = (claimId: string) => createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: new Date().toISOString(),
      payload: {
        actionId,
        message: { text: "staged delete race answer", replyToMessageId: messageId },
        metadata: {
          kind: "final_result",
          turnId,
          appQueueClaimId: claimId,
          queueId,
          dispatchClaimId,
          canonicalMessageId: `assistant-${turnId}`,
          source: "btcc-inbound-dispatcher",
        },
      },
    });
    appendTranscriptEvent(finalEvent(originalClaim), root);
    await server.store.waitForAppTransportProjection();
    while (server.store.syncNextAppTransportBatch()) {
      // Establish the durable deferred row before the stale delete cut.
    }
    expect(server.store.db.query<{ staged: number }, [string]>(`
      SELECT COUNT(*) AS staged
      FROM app_transport_projection_staged_outbounds WHERE action_id = ?
    `).get(actionId)?.staged).toBe(1);
    queueInternals(server.store).kernel.transportProjectionOwner.close();
    mkdirSync(join(root, "runtime", "inbound-events", "processed"), { recursive: true });
    writeFileSync(
      join(root, "runtime", "inbound-events", "processed", `${queueId}.json`),
      JSON.stringify({ metadata: { terminalClaimId: dispatchClaimId } }),
      "utf8",
    );

    const replacementClaim = `app-session-queue:${process.pid}:staged-delete-replacement:${crypto.randomUUID()}`;
    const originalClaimStatus = sessionQueue.queuedTurnClaimStatus.bind(sessionQueue);
    let replaced = false;
    sessionQueue.queuedTurnClaimStatus = (chatId, claimedTurnId, claimId) => {
      const status = originalClaimStatus(chatId, claimedTurnId, claimId);
      if (
        !replaced &&
        claimedTurnId === turnId &&
        claimId === originalClaim &&
        status === "current"
      ) {
        replaced = true;
        const now = new Date();
        server.store.db.query(`
          UPDATE session_queued_messages
          SET claim_id = ?, claim_owner = ?, claimed_at = ?,
            lease_expires_at = ?, updated_at = ?
          WHERE chat_id = ? AND turn_id = ? AND state = 'dispatching'
            AND claim_id = ?
        `).run(
          replacementClaim,
          replacementClaim,
          now.toISOString(),
          new Date(now.getTime() + 60_000).toISOString(),
          now.toISOString(),
          "general",
          turnId,
          originalClaim,
        );
      }
      return status;
    };
    appendTranscriptEvent(finalEvent(originalClaim), root);
    // The owner is closed, so invoke the production projection once at the
    // exact stale pre-delete boundary instead of allowing a retry loop.
    expect(() => {
      while (server.store.syncNextAppTransportBatch()) {
        // Drain the stale final attempt.
      }
    }).not.toThrow();
    expect(replaced).toBeTrue();
    expect(server.store.db.query<{
      staged: number;
      receipts: number;
      queueState: string;
      claimId: string | null;
      assistants: number;
    }, [string, string, string]>(`
      SELECT
        (SELECT COUNT(*) FROM app_transport_projection_staged_outbounds WHERE action_id = ?) AS staged,
        (SELECT COUNT(*) FROM app_transport_projection_receipts WHERE action_id = ?) AS receipts,
        queue.state AS queueState, queue.claim_id AS claimId,
        (SELECT COUNT(*) FROM messages WHERE turn_id = turns.id AND role = 'assistant') AS assistants
      FROM session_queued_messages AS queue
      JOIN turns ON turns.id = queue.turn_id
      WHERE queue.client_message_id = ?
    `).get(actionId, actionId, clientMessageId)).toEqual({
      staged: 1,
      receipts: 0,
      queueState: "dispatching",
      claimId: replacementClaim,
      assistants: 0,
    });

    appendTranscriptEvent(finalEvent(replacementClaim), root);
    while (server.store.syncNextAppTransportBatch()) {
      // The current replay must project the preserved staged action.
    }
    expect(server.store.db.query<{
      staged: number;
      receipts: number;
      queueState: string;
      claimId: string | null;
      assistants: number;
    }, [string, string, string]>(`
      SELECT
        (SELECT COUNT(*) FROM app_transport_projection_staged_outbounds WHERE action_id = ?) AS staged,
        (SELECT COUNT(*) FROM app_transport_projection_receipts WHERE action_id = ?) AS receipts,
        queue.state AS queueState, queue.claim_id AS claimId,
        (SELECT COUNT(*) FROM messages WHERE turn_id = turns.id AND role = 'assistant') AS assistants
      FROM session_queued_messages AS queue
      JOIN turns ON turns.id = queue.turn_id
      WHERE queue.client_message_id = ?
    `).get(actionId, actionId, clientMessageId)).toEqual({
      staged: 0,
      receipts: 1,
      queueState: "dispatched",
      claimId: null,
      assistants: 1,
    });
    void queue;
    void inbound;
    void gateway;
    void deliveryGuard;
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("public replay binds text, ordered attachment identity, and controls without replay side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-identity-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => ({ texts: ["identity-bound answer"] }),
  });
  try {
    const upload = new FormData();
    upload.set("session_id", "general");
    upload.set(
      "file",
      new Blob(["ordered attachment"], { type: "text/plain" }),
      "identity-note.txt",
    );
    const uploadResponse = await fetch(`${server.url}message-files`, {
      method: "POST",
      body: upload,
    });
    expect(uploadResponse.status).toBe(201);
    const uploaded = await uploadResponse.json() as {
      data: { file: { file_id: string } };
    };

    const body = {
      chat_id: "general",
      text: "identity-bound input",
      client_message_id: "client-64646464-6464-4464-8464-646464646464",
      attachments: [{ file_id: uploaded.data.file.file_id }],
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      access_mode: "full_access",
      plan_mode: false,
    };
    const first = await postWithResponse(`${server.url}messages`, body);
    expect(first.response.status).toBe(202);
    await waitForQueueState(dbPath, body.client_message_id, "dispatched");

    const beforeReplay = queueSideEffectSnapshot(server.store.db);
    const replay = await postWithResponse(`${server.url}messages`, body);
    expect(replay.response.status).toBe(202);
    const afterReplay = queueSideEffectSnapshot(server.store.db);
    expect(afterReplay).toEqual(beforeReplay);

    const textConflict = await postWithResponse(`${server.url}messages`, {
      ...body,
      text: "different accepted text",
    });
    expect(textConflict.response.status).toBe(409);
    expect(textConflict.body.error).toMatchObject({
      code: "queued_message_identity_conflict",
    });
    expect(queueSideEffectSnapshot(server.store.db)).toEqual(beforeReplay);

    const controlsConflict = await postWithResponse(`${server.url}messages`, {
      ...body,
      reasoning_effort: "high",
    });
    expect(controlsConflict.response.status).toBe(409);
    expect(controlsConflict.body.error).toMatchObject({
      code: "queued_message_identity_conflict",
    });
    expect(queueSideEffectSnapshot(server.store.db)).toEqual(beforeReplay);
  } finally {
    server.stop();
  }
});

test("public replay rejects unknown attachment identities without side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-unknown-attachment-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => ({ texts: ["unknown attachment answer"] }),
  });
  try {
    const noAttachmentBody = {
      chat_id: "general",
      text: "originally without an attachment",
      client_message_id: "client-79797979-7979-4979-8979-797979797979",
    };
    const first = await postWithResponse(`${server.url}messages`, noAttachmentBody);
    expect(first.response.status).toBe(202);
    await waitForQueueState(dbPath, noAttachmentBody.client_message_id, "dispatched");
    const beforeUnknown = queueSideEffectSnapshot(server.store.db);
    const unknown = await postWithResponse(`${server.url}messages`, {
      ...noAttachmentBody,
      attachments: [{ file_id: "file-does-not-exist" }],
    });
    expect(unknown.response.status).toBe(409);
    expect(unknown.body.error).toMatchObject({ code: "queued_message_identity_conflict" });
    expect(queueSideEffectSnapshot(server.store.db)).toEqual(beforeUnknown);

    const upload = new FormData();
    upload.set("session_id", "general");
    upload.set(
      "file",
      new Blob(["known attachment"], { type: "text/plain" }),
      "known-attachment.txt",
    );
    const uploadResponse = await fetch(`${server.url}message-files`, {
      method: "POST",
      body: upload,
    });
    expect(uploadResponse.status).toBe(201);
    const uploaded = await uploadResponse.json() as {
      data: { file: { file_id: string } };
    };
    const validBody = {
      chat_id: "general",
      text: "originally with one valid attachment",
      client_message_id: "client-80808080-8080-4080-8080-808080808080",
      attachments: [{ file_id: uploaded.data.file.file_id }],
    };
    const valid = await postWithResponse(`${server.url}messages`, validBody);
    expect(valid.response.status).toBe(202);
    await waitForQueueState(dbPath, validBody.client_message_id, "dispatched");
    const beforeValidUnknown = queueSideEffectSnapshot(server.store.db);
    const validUnknown = await postWithResponse(`${server.url}messages`, {
      ...validBody,
      attachments: [
        { file_id: uploaded.data.file.file_id },
        { file_id: "file-unknown-after-valid" },
      ],
    });
    expect(validUnknown.response.status).toBe(409);
    expect(validUnknown.body.error).toMatchObject({ code: "queued_message_identity_conflict" });
    expect(queueSideEffectSnapshot(server.store.db)).toEqual(beforeValidUnknown);
  } finally {
    server.stop();
  }
});

test("strict session-queue ingress preserves the supplied stable client identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-route-identity-"));
  roots.push(root);
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
  });
  try {
    const body = {
      chat_id: "general",
      text: "strict queue route identity",
      client_message_id: "client-65656565-6565-4565-8565-656565656565",
    };
    const response = await postWithResponse(`${server.url}session-queue`, body);
    expect(response.response.status).toBe(202);
    const queueResponse = await fetch(
      `${server.url}session-queue?session_id=general`,
    );
    expect(queueResponse.status).toBe(200);
    const queue = await queueResponse.json() as {
      data: { queued_messages: Array<{ client_message_id?: string; text: string }> };
    };
    expect(queue.data.queued_messages).toContainEqual(expect.objectContaining({
      client_message_id: body.client_message_id,
      text: body.text,
    }));
  } finally {
    server.stop();
  }
});

test("a public input with no visible BTCC result settles as a safe typed queue failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-no-visible-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
  });
  try {
    const clientMessageId = "client-68686868-6868-4686-8686-686868686868";
    const accepted = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "settle an empty BTCC final safely",
      client_message_id: clientMessageId,
    });
    expect(accepted.response.status).toBe(202);
    const row = server.store.db.query<{
      claim_id: string | null;
      turn_id: string | null;
    }, [string]>(`
      SELECT claim_id, turn_id
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    expect(row?.claim_id).toBeString();
    expect(row?.turn_id).toBeString();

    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-08-18T12:00:00.000Z",
      payload: {
        actionId: "queued-input-no-visible:final",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: { text: "" },
        metadata: {
          kind: "final_result",
          turnId: row!.turn_id,
          appQueueClaimId: row!.claim_id,
          source: "test-no-visible-result",
          noVisibleReply: true,
          deliveryState: "recovering_internal",
          limitationCodes: ["internal_recovery_required"],
          limitations: [],
        },
      },
    }), root);
    await server.store.waitForAppTransportProjection();

    const queue = server.store.db.query<{
      state: string;
      safe_error_code: string | null;
      terminal_result_message_id: string | null;
    }, [string]>(`
      SELECT state, safe_error_code, terminal_result_message_id
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    expect(queue).toEqual({
      state: "failed",
      safe_error_code: "no_visible_result",
      terminal_result_message_id: null,
    });
    expect(server.store.db.query<{
      state: string;
      safe_error_code: string | null;
      attempt: number;
    }, [string]>(`
      SELECT state, safe_error_code, attempt
      FROM turns
      WHERE id = ?
    `).get(row!.turn_id!)).toMatchObject({
      state: "failed",
      safe_error_code: "no_visible_result",
      attempt: 1,
    });
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "assistant")).toHaveLength(0);
  } finally {
    server.stop();
    clearNativeReadiness(root);
  }
});

test("production BTCC empty final emits a claimed terminal failure and drains the next input", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-production-empty-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-production-empty",
    sessionBindings: bindings,
    modelRound: emptyThenAnswer("next input answer"),
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  try {
    const firstId = "client-71717171-7171-4171-8171-717171717171";
    const secondId = "client-72727272-7272-4272-8272-727272727272";
    const first = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "production empty final",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      client_message_id: firstId,
    });
    expect(first.response.status).toBe(202);
    const second = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "next input after empty final",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      client_message_id: secondId,
    });
    expect(second.response.status).toBe(202);
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindings }),
      handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
      butlerData: root,
    });
    const deliveryGuard = new DeliveryGuard({
      adapters: [createAppTransportAdapter()],
      butlerData: root,
    });
    let failed = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const summary = inbound.poll({
        queue,
        server: gateway,
        store: bindings,
        deliveryGuard,
        limit: 4,
        maxConcurrentSessions: 1,
      });
      await inbound.waitForIdle();
      failed += summary.failed;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await server.store.waitForAppTransportProjection();
      while (server.store.syncNextAppTransportBatch()) {
        // Drain the bounded projection batch before checking both inputs.
      }
      const state = new Database(dbPath, { readonly: true });
      try {
        const rows = state.query<{ first: string; second: string }, [string, string]>(`
          SELECT
            MAX(CASE WHEN client_message_id = ? THEN state END) AS first,
            MAX(CASE WHEN client_message_id = ? THEN state END) AS second
          FROM session_queued_messages
        `).get(firstId, secondId);
        if (rows?.first === "failed" && rows.second === "dispatched") break;
      } finally {
        state.close();
      }
    }
    expect(failed).toBe(0);
    await waitForQueueState(dbPath, firstId, "failed");
    await waitForQueueState(dbPath, secondId, "dispatched");
    await server.store.waitForAppTransportProjection();
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{
        state: string;
        safe_error_code: string | null;
        turn_id: string | null;
      }, [string]>(`
        SELECT state, safe_error_code, turn_id
        FROM session_queued_messages
        WHERE client_message_id = ?
      `).get(firstId)).toMatchObject({
        state: "failed",
        safe_error_code: "no_visible_result",
        turn_id: expect.any(String),
      });
      expect(db.query<{ state: string; safe_error_code: string | null }, [string]>(`
        SELECT state, safe_error_code FROM turns
        WHERE id = (SELECT turn_id FROM session_queued_messages WHERE client_message_id = ?)
      `).get(firstId)).toEqual({ state: "failed", safe_error_code: "no_visible_result" });
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM messages
        WHERE chat_id = 'general' AND role = 'assistant' AND turn_id =
          (SELECT turn_id FROM session_queued_messages WHERE client_message_id = ?)
      `).get(firstId)?.count).toBe(0);
    } finally {
      db.close();
    }
    const messages = await getJson(`${server.url}messages?chat_id=general&cursor=0`);
    expect(messages.data.messages).toContainEqual(expect.objectContaining({
      role: "user",
      text: "next input after empty final",
    }));
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("a stale claimant cannot settle or overwrite a reclaimed public input", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-fencing-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  let releaseResponder: (() => void) | undefined;
  let responderStarted: (() => void) | undefined;
  const responderStartedPromise = new Promise<void>((resolve) => {
    responderStarted = resolve;
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => {
      responderStarted?.();
      return await new Promise<{ texts: string[] }>((resolve) => {
        releaseResponder = () => resolve({ texts: ["stale completion"] });
      });
    },
  });
  try {
    const clientMessageId = "client-66666666-6666-4666-8666-666666666666";
    const acceptedRequest = postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "fence the old claimant",
      client_message_id: clientMessageId,
    });
    await responderStartedPromise;
    const before = server.store.db.query<{
      id: string;
      claim_id: string | null;
      turn_id: string | null;
      state: string;
    }, [string]>(`
      SELECT id, claim_id, turn_id, state
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    expect(before).toMatchObject({ state: "dispatching" });
    expect(before?.claim_id).toBeString();
    expect(before?.turn_id).toBeString();

    const internal = queueInternals(server.store);
    server.store.db.query(`
      UPDATE session_queued_messages
      SET lease_expires_at = ?
      WHERE id = ?
    `).run(new Date(Date.now() - 1_000).toISOString(), before!.id);
    expect(internal.kernel.sessionQueue.recoverExpiredDispatches(
      "general",
      new Date(),
    )).toBe(1);

    const reclaimed = internal.kernel.sessionQueue.claimDispatch(
      "general",
      before!.id,
      "claim-new-owner",
      "test-new-owner",
    );
    expect(reclaimed).toMatchObject({
      id: before!.id,
      state: "dispatching",
      claim_id: "claim-new-owner",
    });

    expect(internal.kernel.sessionQueue.recordDispatchResult(
      "general",
      before!.id,
      before!.claim_id!,
      { turnId: before!.turn_id! },
    )).toBe(false);
    expect(internal.kernel.sessionQueue.failDispatch(
      "general",
      before!.id,
      before!.claim_id!,
      "stale_owner_failure",
    )).toBe(false);
    expect(internal.kernel.sessionQueue.acknowledgeForTurn({
      chatId: "general",
      turnId: before!.turn_id!,
      claimId: before!.claim_id!,
      safeErrorCode: "stale_owner_failure",
    })).toBe(false);

    const after = server.store.db.query<{
      state: string;
      claim_id: string | null;
      safe_error_code: string | null;
    }, [string]>(`
      SELECT state, claim_id, safe_error_code
      FROM session_queued_messages
      WHERE id = ?
    `).get(before!.id);
    expect(after).toEqual({
      state: "dispatching",
      claim_id: "claim-new-owner",
      safe_error_code: null,
    });
    releaseResponder?.();
    const staleResponse = await acceptedRequest;
    expect(staleResponse.response.status).toBe(202);
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "assistant",
    )).toHaveLength(0);
  } finally {
    releaseResponder?.();
    server.stop();
  }
});

test("a stale responder terminal commit is fenced before files and assistant mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-responder-terminal-race-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  const clientMessageId = "client-69696969-6969-4696-8696-696969696969";
  let responderCalls = 0;
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => {
      responderCalls += 1;
      if (responderCalls > 1) return { texts: ["current responder result"] };
      return {
        texts: ["stale responder result"],
        files: [{
          name: "stale-result.txt",
          mimeType: "text/plain",
          bytes: "stale result file",
        }],
        get delivery() {
          const row = server.store.db.query<{
            id: string;
            claim_id: string | null;
          }, [string]>(`
            SELECT id, claim_id FROM session_queued_messages
            WHERE client_message_id = ?
          `).get(clientMessageId);
          if (!row?.claim_id) throw new Error("missing terminal-race claim");
          server.store.db.query(`
            UPDATE session_queued_messages
            SET claim_id = ?, claim_owner = ?, claimed_at = ?,
              lease_expires_at = ?, updated_at = ?
            WHERE id = ? AND state = 'dispatching' AND claim_id = ?
          `).run(
            "app-session-queue:terminal-replacement",
            "app-session-queue:terminal-replacement",
            new Date().toISOString(),
            new Date(Date.now() + 60_000).toISOString(),
            new Date().toISOString(),
            row.id,
            row.claim_id,
          );
          return undefined;
        },
      };
    },
  });
  try {
    const accepted = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "fence responder terminal commit",
      client_message_id: clientMessageId,
    });
    expect(accepted.response.status).toBe(202);
    const staleRow = server.store.db.query<{
      state: string;
      claim_id: string | null;
      turn_id: string | null;
    }, [string]>(`
      SELECT state, claim_id, turn_id FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    expect(staleRow).toMatchObject({
      state: "dispatching",
      claim_id: "app-session-queue:terminal-replacement",
    });
    expect(server.store.db.query<{ state: string }, [string]>(`
      SELECT state FROM turns WHERE id = ?
    `).get(staleRow!.turn_id!)).toEqual({ state: "thinking" });
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM messages
      WHERE role = 'assistant' AND turn_id = ?
    `).get(staleRow!.turn_id!)?.count).toBe(0);
    expect(server.store.db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM message_files
    `).get()?.count).toBe(0);

    server.store.db.query(`
      UPDATE session_queued_messages
      SET state = 'queued', claim_id = NULL, claim_owner = NULL,
        claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE client_message_id = ?
    `).run(new Date().toISOString(), clientMessageId);
    const replay = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "fence responder terminal commit",
      client_message_id: clientMessageId,
    });
    expect(replay.response.status).toBe(202);
    await waitForQueueState(dbPath, clientMessageId, "dispatched");
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM messages
      WHERE role = 'assistant' AND turn_id = ?
    `).get(staleRow!.turn_id!)?.count).toBe(1);
    expect(server.store.db.query<{ text: string }, [string]>(`
      SELECT text FROM messages
      WHERE role = 'assistant' AND turn_id = ?
    `).get(staleRow!.turn_id!)).toEqual({ text: "current responder result" });
  } finally {
    server.stop();
  }
});

test("a stale responder callback cannot publish progress before current replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-responder-callback-race-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  const clientMessageId = "client-68686868-6868-4686-8686-686868686868";
  let responderCalls = 0;
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async (input) => {
      responderCalls += 1;
      if (responderCalls === 1) {
        const row = server.store.db.query<{
          id: string;
          claim_id: string | null;
        }, [string]>(`
          SELECT id, claim_id FROM session_queued_messages
          WHERE client_message_id = ?
        `).get(clientMessageId);
        if (!row?.claim_id) throw new Error("missing callback-race claim");
        server.store.db.query(`
          UPDATE session_queued_messages
          SET claim_id = ?, claim_owner = ?, claimed_at = ?,
            lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND state = 'dispatching' AND claim_id = ?
        `).run(
          "app-session-queue:callback-replacement",
          "app-session-queue:callback-replacement",
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          new Date().toISOString(),
          row.id,
          row.claim_id,
        );
        input.onProgress?.({
          id: "stale-responder-progress",
          kind: "tool_progress",
          state: "running",
          safe_label: "Stale responder progress",
          safe_tool_name: "Search",
          safe_input_label: "stale callback",
          tool_call_id: "stale-responder-progress",
        });
        input.onTurnEvent?.({
          kind: "tool.completed",
          payload: {
            toolCallId: "stale-responder-event",
            toolName: "Search",
            inputLabel: "stale callback",
            safeLabel: "Stale responder event",
          },
        });
        return { texts: ["stale responder result"] };
      }
      return { texts: ["current responder result"] };
    },
  });
  try {
    const accepted = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "fence responder callback writes",
      client_message_id: clientMessageId,
    });
    expect(accepted.response.status).toBe(202);
    const staleRow = server.store.db.query<{
      state: string;
      claim_id: string | null;
      turn_id: string | null;
    }, [string]>(`
      SELECT state, claim_id, turn_id FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    expect(staleRow).toMatchObject({
      state: "dispatching",
      claim_id: "app-session-queue:callback-replacement",
    });
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM events
      WHERE type = 'progress.summary'
        AND json_extract(payload_json, '$.turn_id') = ?
    `).get(staleRow!.turn_id!)?.count).toBe(0);
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM events
      WHERE type = 'agent.turn_event'
        AND json_extract(payload_json, '$.turn_id') = ?
        AND json_extract(payload_json, '$.event.payload.toolCallId') = 'stale-responder-event'
    `).get(staleRow!.turn_id!)?.count).toBe(0);
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "assistant" && message.turn_id === staleRow!.turn_id,
    )).toHaveLength(0);

    server.store.db.query(`
      UPDATE session_queued_messages
      SET state = 'queued', claim_id = NULL, claim_owner = NULL,
        claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE client_message_id = ?
    `).run(new Date().toISOString(), clientMessageId);
    const replay = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "fence responder callback writes",
      client_message_id: clientMessageId,
    });
    expect(replay.response.status).toBe(202);
    await waitForQueueState(dbPath, clientMessageId, "dispatched");
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "assistant" && message.turn_id === staleRow!.turn_id,
    )).toHaveLength(1);
    expect(server.store.listMessages("general").find((message) =>
      message.role === "assistant" && message.turn_id === staleRow!.turn_id,
    )?.text).toBe("current responder result");
  } finally {
    server.stop();
  }
});

test("the post-Turn admission crash cut rolls back the Turn, message, attachments, and queue link", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-admission-gap-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  const clientMessageId = "client-67676767-6767-4676-8676-676767676767";
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => ({ texts: ["replayed after admission rollback"] }),
  });
  try {
    server.store.db.exec(`
      CREATE TRIGGER fail_after_turn_insert
      AFTER INSERT ON turns
      BEGIN
        SELECT RAISE(ABORT, 'fault after durable Turn insert');
      END;
    `);
    const first = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "rollback the exact admission cut",
      client_message_id: clientMessageId,
    });
    expect(first.response.status).toBe(202);
    await waitForQueueState(dbPath, clientMessageId, "failed");
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE chat_id = 'general' AND role = 'user' AND id = ?
    `).get(clientMessageId)?.count).toBe(0);
    expect(server.store.db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count
      FROM turns
      WHERE chat_id = 'general'
    `).get()?.count).toBe(0);
    expect(server.store.db.query<{ turn_id: string | null; dispatched_message_id: string | null }, [string]>(`
      SELECT turn_id, dispatched_message_id
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId)).toEqual({
      turn_id: null,
      dispatched_message_id: null,
    });

    server.store.db.exec("DROP TRIGGER fail_after_turn_insert");
    server.store.db.query(`
      UPDATE session_queued_messages
      SET state = 'queued', safe_error_code = NULL, claim_id = NULL,
        claim_owner = NULL, claimed_at = NULL, lease_expires_at = NULL,
        updated_at = ?
      WHERE client_message_id = ?
    `).run(new Date().toISOString(), clientMessageId);
    const replay = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "rollback the exact admission cut",
      client_message_id: clientMessageId,
    });
    expect(replay.response.status).toBe(202);
    await waitForQueueState(dbPath, clientMessageId, "dispatched");
    expect(server.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE chat_id = 'general' AND role = 'user' AND id = ?
    `).get(clientMessageId)?.count).toBe(1);
    expect(server.store.db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count
      FROM turns
      WHERE chat_id = 'general'
    `).get()?.count).toBe(1);
  } finally {
    server.stop();
  }
});

test("migration backfills legacy input identity and restart reclaims its dispatching row", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-migration-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  let server: ReturnType<typeof createTestAppServer> | undefined = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
  });
  let relaunched: ReturnType<typeof createTestAppServer> | undefined;
  try {
    const now = new Date().toISOString();
    server.store.db.query(`
      INSERT INTO turns (
        id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
        retryable, cancellable, attempt, execution_controls_json,
        execution_model_json, created_at, updated_at
      ) VALUES ('turn-legacy-blocker', 'general', NULL, 'thinking', 'Thinking',
        NULL, 0, 1, 1, NULL, NULL, ?, ?)
    `).run(now, now);
    server.store.db.query(`
      INSERT INTO session_queued_messages (
        id, chat_id, text, client_message_id, input_identity_digest,
        control_resolution_json, controls_json, attachments_json, state,
        safe_error_code, dispatched_message_id, turn_id, claim_id, claim_owner,
        claimed_at, lease_expires_at, terminal_result_message_id, created_at,
        updated_at
      ) VALUES ('queued-legacy-recovery', 'general', 'legacy accepted input',
        NULL, NULL, NULL,
        '{"model":"openai/gpt-5.5","reasoning_effort":"none","access_mode":"full_access","plan_mode":false}',
        '[]', 'dispatching', NULL, NULL, NULL, 'legacy-claim',
        'app-session-queue:999999:legacy-process', ?, ?, NULL, ?, ?)
    `).run(
      new Date(Date.now() - 1_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
      now,
      now,
    );

    migrateAppStoreSchema(server.store.db, { butlerData: root });
    const migrated = server.store.db.query<{
      client_message_id: string | null;
      input_identity_digest: string | null;
      control_resolution_json: string | null;
    }, []>(`
      SELECT client_message_id, input_identity_digest, control_resolution_json
      FROM session_queued_messages
      WHERE id = 'queued-legacy-recovery'
    `).get();
    expect(migrated?.client_message_id).toMatch(/^client-[0-9a-f-]{36}$/u);
    expect(migrated?.input_identity_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.parse(migrated!.control_resolution_json!)).toMatchObject({
      source: "session_override",
      controls: { model: "openai/gpt-5.5" },
    });
    const migratedClientMessageId = migrated!.client_message_id!;

    server.stop();
    server = undefined;
    relaunched = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
    });
    await waitForQueueState(dbPath, "queued-legacy-recovery", "queued");
    const replay = await postWithResponse(`${relaunched.url}messages`, {
      chat_id: "general",
      text: "legacy accepted input",
      client_message_id: migratedClientMessageId,
      model: "openai/gpt-5.5",
      reasoning_effort: "none",
      access_mode: "full_access",
      plan_mode: false,
    });
    expect(replay.response.status).toBe(202);
    expect(replay.body.data?.queued).toMatchObject({
      id: "queued-legacy-recovery",
      client_message_id: migratedClientMessageId,
      state: "queued",
    });
    const recovered = new Database(dbPath, { readonly: true });
    try {
      expect(recovered.query<{
        state: string;
        claim_id: string | null;
        client_message_id: string | null;
        input_identity_digest: string | null;
      }, []>(`
        SELECT state, claim_id, client_message_id, input_identity_digest
        FROM session_queued_messages
        WHERE id = 'queued-legacy-recovery'
      `).get()).toMatchObject({
        state: "queued",
        claim_id: null,
        client_message_id: expect.stringMatching(/^client-[0-9a-f-]{36}$/u),
        input_identity_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    } finally {
      recovered.close();
    }
  } finally {
    relaunched?.stop();
    server?.stop();
  }
});

test("production App replay does not execute a reviewed workspace effect twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-effect-replay-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const effectCall = {
    id: "effect-call-once",
    name: "write_file",
    arguments: {
      path: "effect-once.txt",
      content: "one durable effect\n",
      overwrite: false,
      create_parents: false,
    },
    rawArguments: JSON.stringify({
      path: "effect-once.txt",
      content: "one durable effect\n",
      overwrite: false,
      create_parents: false,
    }),
  };
  let modelRoundCalls = 0;
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "queued-input-effect-replay",
    sessionBindings: bindings,
    modelRound: {
      async runRound() {
        modelRoundCalls += 1;
        if (modelRoundCalls === 1) {
          return {
            toolCalls: [
              {
                id: "effect-plan",
                name: "replace_work_plan",
                arguments: {
                  start_new: true,
                  objective: "Create the reviewed effect file",
                  actions: [{
                    action_key: "write-effect-file",
                    description: "Write the requested effect file",
                    effect: {
                      capability: "write_file",
                      target: "workspace:effect-once.txt",
                    },
                  }],
                  checks: ["effect-once.txt contains the requested content"],
                },
                rawArguments: JSON.stringify({
                  start_new: true,
                  objective: "Create the reviewed effect file",
                  actions: [{
                    action_key: "write-effect-file",
                    description: "Write the requested effect file",
                    effect: {
                      capability: "write_file",
                      target: "workspace:effect-once.txt",
                    },
                  }],
                  checks: ["effect-once.txt contains the requested content"],
                }),
              },
              {
                id: "effect-plan-review",
                name: "record_work_review",
                arguments: {
                  subject: "plan",
                  verdict: "accept",
                  summary: "The reviewed plan writes the requested file.",
                },
                rawArguments: JSON.stringify({
                  subject: "plan",
                  verdict: "accept",
                  summary: "The reviewed plan writes the requested file.",
                }),
              },
              {
                id: "effect-describe",
                name: "tool_describe",
                arguments: { ids: ["native:write_file"] },
                rawArguments: JSON.stringify({ ids: ["native:write_file"] }),
              },
              {
                id: "effect-write",
                name: "tool_call",
                arguments: {
                  id: "native:write_file",
                  arguments: {
                    path: effectCall.arguments.path,
                    content: effectCall.arguments.content,
                  },
                },
                rawArguments: JSON.stringify({
                  id: "native:write_file",
                  arguments: {
                    path: effectCall.arguments.path,
                    content: effectCall.arguments.content,
                  },
                }),
              },
              {
                id: "effect-result-review",
                name: "record_work_review",
                arguments: {
                  subject: "result",
                  verdict: "accept",
                  summary: "The requested file was written with the exact content.",
                },
                rawArguments: JSON.stringify({
                  subject: "result",
                  verdict: "accept",
                  summary: "The requested file was written with the exact content.",
                }),
              },
            ],
          };
        }
        return { text: "effect completed", toolCalls: [] };
      },
    },
  });
  let server: ReturnType<typeof createTestAppServer> | undefined = createTestAppServer({
    dbPath,
    butlerData: root,
    butlerHome: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  let relaunched: ReturnType<typeof createTestAppServer> | undefined;
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const clientMessageId = "client-36363636-3636-4636-8636-363636363636";
  try {
    const accepted = await postWithResponse(`${server.url}messages`, {
      chat_id: "general",
      text: "perform one reviewed workspace effect and answer",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      access_mode: "full_access",
      client_message_id: clientMessageId,
    });
    expect(accepted.response.status).toBe(202);
    const turnId = accepted.body.data?.turn?.id;
    if (typeof turnId !== "string") throw new Error("App response omitted Turn identity");
    const before = server.store.db.query<{
      state: string;
      claim_id: string | null;
    }, [string]>(`
      SELECT state, claim_id
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId);
    expect(before).toMatchObject({ state: "dispatching" });
    expect(before?.claim_id).toBeString();
    server.store.db.exec(`
      CREATE TRIGGER fail_effect_replay_queue_ack
      BEFORE UPDATE OF state ON session_queued_messages
      WHEN OLD.state = 'dispatching' AND NEW.state IN ('dispatched', 'failed')
      BEGIN
        SELECT RAISE(ABORT, 'effect replay acknowledgement fault');
      END;
    `);
    const summary = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    expect(summary.claimed).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(modelRoundCalls).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(root, "effect-once.txt"))).toBe(true);
    expect(readFileSync(join(root, "effect-once.txt"), "utf8")).toBe(
      "one durable effect\n",
    );
    const effectDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(effectDb.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_guided_tool_calls
        WHERE turn_id = ? AND tool_name = 'write_file'
      `).get(turnId)?.count).toBe(1);
      expect(effectDb.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_guided_effects
        WHERE capability = 'write_file'
      `).get()?.count).toBe(1);
      expect(effectDb.query<{ dispatch_attempts: number; status: string }, []>(`
        SELECT dispatch_attempts, status FROM btcc_guided_effects
        WHERE capability = 'write_file'
      `).get()).toEqual({ dispatch_attempts: 1, status: "applied" });
    } finally {
      effectDb.close();
    }

    server.stop();
    server = undefined;
    const maintenanceDb = new Database(dbPath);
    try {
      maintenanceDb.exec("DROP TRIGGER fail_effect_replay_queue_ack");
    } finally {
      maintenanceDb.close();
    }
    relaunched = createTestAppServer({
      dbPath,
      butlerData: root,
      butlerHome: root,
      port: 0,
      automationSchedulerIntervalMs: false,
    });
    const replay = await postWithResponse(`${relaunched.url}messages`, {
      chat_id: "general",
      text: "perform one reviewed workspace effect and answer",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      access_mode: "full_access",
      client_message_id: clientMessageId,
    });
    expect(replay.response.status).toBe(202);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      inbound.poll({
        queue,
        server: gateway,
        store: bindings,
        deliveryGuard,
        limit: 4,
        maxConcurrentSessions: 1,
      });
      await inbound.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await relaunched.store.waitForAppTransportProjection();
      while (relaunched.store.syncNextAppTransportBatch()) {
        // Re-enter the canonical production projection after restart.
      }
      const state = relaunched.store.db.query<{ state: string }, [string]>(`
        SELECT state FROM session_queued_messages
        WHERE client_message_id = ?
      `).get(clientMessageId)?.state;
      if (state === "dispatched") break;
    }
    expect(relaunched.store.db.query<{ state: string; claim_id: string | null }, [string]>(`
      SELECT state, claim_id FROM session_queued_messages
      WHERE client_message_id = ?
    `).get(clientMessageId)).toEqual({ state: "dispatched", claim_id: null });
    expect(relaunched.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM messages
      WHERE chat_id = 'general' AND role = 'user'
        AND id = ?
    `).get(clientMessageId)?.count).toBe(1);
    expect(relaunched.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM turns WHERE id = ?
    `).get(turnId)?.count).toBe(1);
    expect(relaunched.store.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM messages
      WHERE turn_id = ? AND role = 'assistant'
    `).get(turnId)?.count).toBe(1);
    const finalEffectDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(finalEffectDb.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_guided_tool_calls
        WHERE turn_id = ? AND tool_name = 'write_file'
      `).get(turnId)?.count).toBe(1);
      expect(finalEffectDb.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_guided_effects
        WHERE capability = 'write_file'
      `).get()?.count).toBe(1);
    } finally {
      finalEffectDb.close();
    }
  } finally {
    relaunched?.stop();
    server?.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

function queueSideEffectSnapshot(db: Database): {
  queue: number;
  userMessages: number;
  turns: number;
  assistantMessages: number;
  controlEvents: number;
} {
  return {
    queue: db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM session_queued_messages
    `).get()?.count ?? 0,
    userMessages: db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM messages
      WHERE chat_id = 'general' AND role = 'user'
    `).get()?.count ?? 0,
    turns: db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM turns WHERE chat_id = 'general'
    `).get()?.count ?? 0,
    assistantMessages: db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM messages
      WHERE chat_id = 'general' AND role = 'assistant'
    `).get()?.count ?? 0,
    controlEvents: db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM events
      WHERE type = 'session.controls_updated'
        AND json_extract(payload_json, '$.session_id') = 'general'
    `).get()?.count ?? 0,
  };
}

type QueueInternals = {
  kernel: {
    sessionQueueDispatcher: {
      close(): void;
    };
    transportProjectionOwner: {
      close(): void;
    };
    sessionQueue: {
      recoverExpiredDispatches(
        chatId?: string,
        now?: Date,
        currentOwner?: string,
      ): number;
      claimDispatch(
        chatId: string,
        queuedMessageId: string,
        claimId: string,
        claimOwner: string,
        now?: Date,
        leaseMs?: number,
      ): { state: string } | null;
      recordDispatchResult(
        chatId: string,
        queuedMessageId: string,
        claimId: string,
        result: { messageId?: string; turnId?: string },
      ): boolean;
      failDispatch(
        chatId: string,
        queuedMessageId: string,
        claimId: string,
        safeErrorCode: string,
      ): boolean;
      queuedTurnClaimStatus(
        chatId: string,
        turnId: string,
        claimId?: string,
      ): "unlinked" | "current" | "terminal" | "stale";
      fenceQueuedTurnClaim(input: {
        chatId: string;
        turnId: string;
        claimId: string;
      }): boolean;
      acknowledgeForTurn(input: {
        chatId: string;
        turnId: string;
        claimId: string;
        resultMessageId?: string;
        safeErrorCode?: string | null;
      }): boolean;
    };
  };
};

function queueInternals(store: unknown): QueueInternals {
  return store as QueueInternals;
}

async function postWithResponse(
  url: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; body: { data?: Record<string, any>; error?: Record<string, any> } }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    response,
    body: await response.json() as {
      data?: Record<string, any>;
      error?: Record<string, any>;
    },
  };
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  return await response.json();
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let value = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("child process exited before announcing App server");
    value += new TextDecoder().decode(chunk.value);
    const newline = value.indexOf("\n");
    if (newline >= 0) {
      reader.releaseLock();
      return value.slice(0, newline).trim();
    }
  }
}

async function waitForQueueState(
  dbPath: string,
  identifier: string,
  state: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query<{ state: string }, [string, string]>(`
        SELECT state FROM session_queued_messages
        WHERE client_message_id = ? OR id = ?
        ORDER BY rowid DESC LIMIT 1
      `).get(identifier, identifier);
      if (row?.state === state) return;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const snapshot = new Database(dbPath, { readonly: true });
  try {
    throw new Error(`Queue row ${identifier} did not become ${state}: ${JSON.stringify({
      queue: snapshot.query("SELECT client_message_id, state, claim_id, claim_owner, lease_expires_at, turn_id FROM session_queued_messages").all(),
      turns: snapshot.query("SELECT id, state, safe_error_code FROM turns").all(),
      messages: snapshot.query("SELECT id, role, status, text, turn_id, safe_error_code FROM messages").all(),
      receipts: snapshot.query("SELECT action_id FROM projected_transport_events").all(),
      transcriptFiles: readdirSync(join(dbPath, "..", "transcripts"), { withFileTypes: true }).map((entry) => entry.name),
    })}`);
  } finally {
    snapshot.close();
  }
}

function publishNativeReadiness(root: string): void {
  writeFileSync(
    join(root, "eol.md"),
    "Act only from explicit evidence and preserve the exact reviewed objective.\n",
    "utf8",
  );
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "butler-main-native.json"),
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      runtime: "test-native-butler",
      launcher: "test",
    }),
    "utf8",
  );
}

function clearNativeReadiness(root: string): void {
  rmSync(join(root, "state", "butler-main-native.json"), { force: true });
}

function emptyThenAnswer(text: string): ModelRoundPort {
  let calls = 0;
  return {
    async runRound() {
      calls += 1;
      return calls <= 2 ? { text: "", toolCalls: [] } : { text, toolCalls: [] };
    },
  };
}

function oneRoundAnswer(text: string): ModelRoundPort {
  return {
    async runRound() {
      return { text, toolCalls: [] };
    },
  };
}
