/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { ButlerServiceClient } from "../../packages/butler-agent/src/gateways/core/client.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { sessionHintForRow } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import type { ModelRoundPort } from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("real App sends persist an accepted queue input before the response", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-recovery-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => ({ texts: ["queued result"] }),
  });
  try {
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "persist this before acknowledging",
        client_message_id: "client-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    });
    expect(response.status).toBe(202);

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query<{
        client_message_id: string;
        state: string;
      }, [string]>(`
        SELECT client_message_id, state
        FROM session_queued_messages
        WHERE chat_id = 'general' AND client_message_id = ?
      `).get("client-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      expect(row).toMatchObject({
        client_message_id: "client-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        state: "dispatched",
      });
    } finally {
      db.close();
    }
  } finally {
    server.stop();
  }
});

test("replaying one public client input does not create a second Turn or message", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-idempotency-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => ({ texts: ["one durable answer"] }),
  });
  try {
    const body = {
      chat_id: "general",
      text: "one accepted input",
      client_message_id: "client-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    const first = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const replay = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
        FROM session_queued_messages
        WHERE chat_id = 'general'
      `).get()?.count).toBe(1);
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE chat_id = 'general' AND role = 'user' AND id = ?
      `).get("client-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")?.count).toBe(1);
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count
        FROM turns
        WHERE chat_id = 'general' AND user_message_id = ?
      `).get("client-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")?.count).toBe(1);
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE chat_id = 'general' AND role = 'assistant'
      `).get()?.count).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    server.stop();
  }
});

test("concurrent public sends keep one active Turn and drain accepted order", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-order-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  let releaseFirst: (() => void) | undefined;
  let firstStarted: (() => void) | undefined;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async (input) => {
      if (input.text === "first ordered input") {
        firstStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { texts: [`ordered answer: ${input.text}`] };
    },
  });
  try {
    const firstBody = {
      chat_id: "general",
      text: "first ordered input",
      client_message_id: "client-11111111-1111-4111-8111-111111111111",
    };
    const secondBody = {
      chat_id: "general",
      text: "second ordered input",
      client_message_id: "client-22222222-2222-4222-8222-222222222222",
    };
    const firstRequest = postMessage(server.url, firstBody);
    await firstStartedPromise;
    const secondRequest = postMessage(server.url, secondBody);
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    expect(first.data.turn).toMatchObject({ state: "thinking" });
    expect(second.data.queued).toMatchObject({ state: "queued" });

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.query<{
        text: string;
        state: string;
      }, []>(`
        SELECT text, state
        FROM session_queued_messages
        WHERE chat_id = 'general'
        ORDER BY rowid ASC
      `).all();
      expect(rows).toEqual([
        { text: "first ordered input", state: "dispatching" },
        { text: "second ordered input", state: "queued" },
      ]);
    } finally {
      db.close();
    }

    releaseFirst?.();
    await waitForQueueState(
      dbPath,
      "client-11111111-1111-4111-8111-111111111111",
      "dispatched",
    );
    await waitForQueueState(
      dbPath,
      "client-22222222-2222-4222-8222-222222222222",
      "dispatched",
    );
    const messages = await getJson(`${server.url}messages?chat_id=general&cursor=0`);
    expect(messages.data.messages.map((message: { role: string; text: string }) =>
      `${message.role}:${message.text}`)).toEqual([
        "user:first ordered input",
        "assistant:ordered answer: first ordered input",
        "user:second ordered input",
        "assistant:ordered answer: second ordered input",
      ]);
  } finally {
    server.stop();
  }
});

test("transport handoff failure is a safe terminal queue result visible to the App", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-failure-"));
  roots.push(root);
  const serviceClient: ButlerServiceClient = {
    findAppTurn() {
      return null;
    },
    enqueueAppCancellation() {
      throw new Error("unexpected cancellation");
    },
    enqueueAppResume() {
      throw new Error("unexpected resume");
    },
    enqueueAppTurn() {
      throw new Error("simulated queue write failure");
    },
  };
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    serviceClient,
  });
  try {
    const result = await postMessage(server.url, {
      chat_id: "general",
      text: "show a safe queue failure",
      client_message_id: "client-33333333-3333-4333-8333-333333333333",
    });
    expect(result.data.turn).toMatchObject({
      state: "failed",
      safe_error_code: "app_turn_queue_failed",
      cancellable: false,
    });
    const queue = await getJson(`${server.url}session-queue?session_id=general`);
    expect(queue.data.queued_messages).toContainEqual(expect.objectContaining({
      client_message_id: "client-33333333-3333-4333-8333-333333333333",
      state: "failed",
      safe_error_code: "app_turn_queue_failed",
    }));
    expect(JSON.stringify(queue)).not.toContain("simulated queue write failure");
    const failed = queue.data.queued_messages.find((item: { client_message_id?: string }) =>
      item.client_message_id === "client-33333333-3333-4333-8333-333333333333",
    );
    const deleted = await fetch(`${server.url}session-queue/${failed.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data.queued_messages).toEqual([]);
  } finally {
    server.stop();
  }
});

test("responder failure links a visible typed terminal result to its accepted input", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-responder-failure-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    responder: async () => {
      throw new Error("private provider details must not be public");
    },
  });
  try {
    const result = await postMessage(server.url, {
      chat_id: "general",
      text: "fail this accepted input safely",
      client_message_id: "client-45454545-4545-4454-8454-454545454545",
    });
    expect(result.data.turn).toMatchObject({ state: "thinking" });
    await waitForQueueState(
      dbPath,
      "client-45454545-4545-4454-8454-454545454545",
      "failed",
    );
    const queue = await getJson(`${server.url}session-queue?session_id=general`);
    const failedQueue = queue.data.queued_messages.find(
      (item: { client_message_id?: string }) =>
        item.client_message_id === "client-45454545-4545-4454-8454-454545454545",
    );
    expect(failedQueue).toMatchObject({
      state: "failed",
      safe_error_code: "gateway_failed",
      terminal_result_message_id: expect.any(String),
    });
    const messages = await getJson(`${server.url}messages?chat_id=general&cursor=0`);
    expect(messages.data.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      status: "failed",
      safe_error_code: "gateway_failed",
    }));
    expect(JSON.stringify(messages)).not.toContain("private provider details");
  } finally {
    server.stop();
  }
});

test("real App queue drains through NativeInboundQueue, BTCC production composition, and projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-btcc-"));
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
    ownerId: "queued-input-btcc-test",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("production BTCC answer"),
  });
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  try {
    const acceptedBody = {
      chat_id: "general",
      text: "run through production BTCC",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      client_message_id: "client-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    };
    const accepted = await postMessage(server.url, acceptedBody);
    expect(accepted.data.turn).toMatchObject({ state: "thinking" });
    const replay = await postMessage(server.url, acceptedBody);
    expect(replay.data.queued).toMatchObject({
      client_message_id: acceptedBody.client_message_id,
      state: "dispatching",
    });
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindings }),
      handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
      butlerData: root,
    });
    const summary = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard: new DeliveryGuard({
        adapters: [createAppTransportAdapter()],
        butlerData: root,
      }),
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    expect(summary.claimed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.interrupted).toBe(0);
    await waitForQueueState(
      dbPath,
      "client-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "dispatched",
    );
    const messages = await waitForAssistantMessage(server.url, "production BTCC answer");
    expect(messages).toMatchObject({
      role: "assistant",
      text: "production BTCC answer",
      status: "delivered",
    });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM messages
        WHERE chat_id = 'general' AND role = 'user'
      `).get()?.count).toBe(1);
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM turns WHERE chat_id = 'general'
      `).get()?.count).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("restart reclaims an expired dispatch lease and resumes through the App queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-restart-"));
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
    ownerId: "queued-input-restart-test",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("recovered answer"),
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const dispatchOptions = {
    queue,
    server: gateway,
    store: bindings,
    deliveryGuard: new DeliveryGuard({
      adapters: [createAppTransportAdapter()],
      butlerData: root,
    }),
    limit: 4,
    maxConcurrentSessions: 1,
  };
  let server: ReturnType<typeof createTestAppServer> | undefined = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
  });
  let relaunched: ReturnType<typeof createTestAppServer> | undefined;
  try {
    const first = await postMessage(server.url, {
      chat_id: "general",
      text: "complete before the restart",
      client_message_id: "client-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(first.data.turn).toMatchObject({ state: "thinking" });
    inbound.poll(dispatchOptions);
    await inbound.waitForIdle();
    await waitForQueueState(
      dbPath,
      "client-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dispatched",
    );

    const second = await postMessage(server.url, {
      chat_id: "general",
      text: "recover this after process loss",
      client_message_id: "client-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    expect(second.data.turn).toMatchObject({ state: "thinking" });

    const claimed = new Database(dbPath, { readonly: true });
    let secondTurnId = "";
    try {
      const row = claimed.query<{ state: string; turn_id: string }, [string]>(`
        SELECT state, turn_id
        FROM session_queued_messages
        WHERE client_message_id = ?
      `).get("client-dddddddd-dddd-4ddd-8ddd-dddddddddddd");
      expect(row).toMatchObject({ state: "dispatching" });
      expect(row?.turn_id).toBeString();
      secondTurnId = row!.turn_id;
    } finally {
      claimed.close();
    }

    // Simulate process loss after the App queue claim and Turn creation, before
    // the BTCC transport has committed its terminal result.
    server.stop();
    server = undefined;
    const expired = new Database(dbPath);
    try {
      expired.query(`
        UPDATE session_queued_messages
        SET lease_expires_at = ?
        WHERE client_message_id = ?
      `).run(
        new Date(Date.now() - 60_000).toISOString(),
        "client-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      );
    } finally {
      expired.close();
    }

    relaunched = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
    });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      inbound.poll(dispatchOptions);
      await inbound.waitForIdle();
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.query<{ state: string; turn_id: string }, [string]>(`
          SELECT state, turn_id
          FROM session_queued_messages
          WHERE client_message_id = ?
        `).get("client-dddddddd-dddd-4ddd-8ddd-dddddddddddd");
        if (row?.state === "dispatched" && row.turn_id === secondTurnId) break;
      } finally {
        db.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await waitForQueueState(
      dbPath,
      "client-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "dispatched",
    );
    const messages = await getJson(`${relaunched.url}messages?chat_id=general&cursor=0`);
    expect(messages.data.messages).toContainEqual(expect.objectContaining({
      id: "client-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      role: "user",
      text: "recover this after process loss",
    }));
    expect(messages.data.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      text: "recovered answer",
      status: "delivered",
    }));
  } finally {
    if (relaunched) relaunched.stop();
    if (server) server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("restart reclaims a stopped same-process owner before lease expiry", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-preexpiry-"));
  roots.push(root);
  const dbPath = join(root, "app.sqlite");
  publishNativeReadiness(root);
  let server: ReturnType<typeof createTestAppServer> | undefined = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
  });
  let relaunched: ReturnType<typeof createTestAppServer> | undefined;
  try {
    const accepted = await postMessage(server.url, {
      chat_id: "general",
      text: "lease expires after relaunch",
      client_message_id: "client-9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a",
    });
    expect(accepted.data.turn).toMatchObject({ state: "thinking" });
    const beforeRestart = new Database(dbPath, { readonly: true });
    let previousClaimOwner: string | null;
    try {
      const row = beforeRestart.query<{ claim_owner: string | null }, [string]>(`
        SELECT claim_owner
        FROM session_queued_messages
        WHERE client_message_id = ?
      `).get("client-9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a");
      previousClaimOwner = row?.claim_owner ?? null;
    } finally {
      beforeRestart.close();
    }
    expect(previousClaimOwner).toBeString();
    server.stop();
    server = undefined;
    relaunched = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterExpiry = new Database(dbPath, { readonly: true });
    try {
      const row = afterExpiry.query<{
        state: string;
        claim_owner: string | null;
        lease_expires_at: string | null;
        turn_id: string | null;
      }, [string]>(`
        SELECT state, claim_owner, lease_expires_at, turn_id
        FROM session_queued_messages
        WHERE client_message_id = ?
      `).get("client-9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a");
      expect(row?.state).toBe("dispatching");
      expect(row?.claim_owner).toMatch(/^app-session-queue:/u);
      // The prior store was stopped, so its same-PID incarnation is no longer
      // live.  A genuinely live sibling is covered separately.
      expect(row?.claim_owner).not.toBe(previousClaimOwner);
      expect(row?.lease_expires_at).toBeString();
      expect(new Date(row!.lease_expires_at!).getTime()).toBeGreaterThan(Date.now());
      expect(row?.turn_id).toBeString();
    } finally {
      afterExpiry.close();
    }
  } finally {
    if (relaunched) relaunched.stop();
    if (server) server.stop();
    clearNativeReadiness(root);
  }
});

test("restart lets a queued input resume after loss before its App claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-before-claim-"));
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
    ownerId: "queued-input-before-claim-test",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("before-claim answer"),
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const dispatchOptions = {
    queue,
    server: gateway,
    store: bindings,
    deliveryGuard: new DeliveryGuard({
      adapters: [createAppTransportAdapter()],
      butlerData: root,
    }),
    limit: 4,
    maxConcurrentSessions: 1,
  };
  let server: ReturnType<typeof createTestAppServer> | undefined = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
  });
  let relaunched: ReturnType<typeof createTestAppServer> | undefined;
  try {
    const first = await postMessage(server.url, {
      chat_id: "general",
      text: "finish after relaunch",
      client_message_id: "client-ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    expect(first.data.turn).toMatchObject({ state: "thinking" });
    const second = await postMessage(server.url, {
      chat_id: "general",
      text: "queued before process loss",
      client_message_id: "client-12121212-1212-4121-8121-121212121212",
    });
    expect(second.data.queued).toMatchObject({ state: "queued" });

    const beforeLoss = new Database(dbPath, { readonly: true });
    try {
      expect(beforeLoss.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
        FROM session_queued_messages
        WHERE state = 'queued'
      `).get()?.count).toBe(1);
    } finally {
      beforeLoss.close();
    }

    server.stop();
    server = undefined;
    relaunched = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      inbound.poll(dispatchOptions);
      await inbound.waitForIdle();
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.query<{ state: string }, []>(`
          SELECT state
          FROM session_queued_messages
          WHERE chat_id = 'general'
          ORDER BY rowid ASC
        `).all();
        if (rows.length === 2 && rows.every((row) => row.state === "dispatched")) break;
      } finally {
        db.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await waitForQueueState(
      dbPath,
      "client-12121212-1212-4121-8121-121212121212",
      "dispatched",
    );
    const messages = await getJson(`${relaunched.url}messages?chat_id=general&cursor=0`);
    expect(messages.data.messages.filter((message: { role: string }) =>
      message.role === "user")).toHaveLength(2);
    expect(messages.data.messages.filter((message: { role: string; text: string }) =>
      message.role === "assistant" && message.text === "before-claim answer")).toHaveLength(2);
  } finally {
    if (relaunched) relaunched.stop();
    if (server) server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("restart reclaims an App claim lost before Turn creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-claim-only-"));
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
    ownerId: "queued-input-claim-only-test",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("claim-only answer"),
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const dispatchOptions = {
    queue,
    server: gateway,
    store: bindings,
    deliveryGuard: new DeliveryGuard({
      adapters: [createAppTransportAdapter()],
      butlerData: root,
    }),
    limit: 4,
    maxConcurrentSessions: 1,
  };
  let server: ReturnType<typeof createTestAppServer> | undefined = createTestAppServer({
    dbPath,
    butlerData: root,
    port: 0,
  });
  let relaunched: ReturnType<typeof createTestAppServer> | undefined;
  try {
    const first = await postMessage(server.url, {
      chat_id: "general",
      text: "hold the session for the claim-only crash",
      client_message_id: "client-56565656-5656-4565-8565-565656565656",
    });
    expect(first.data.turn).toMatchObject({ state: "thinking" });
    const second = await postMessage(server.url, {
      chat_id: "general",
      text: "claim this before creating a Turn",
      client_message_id: "client-78787878-7878-4787-8787-787878787878",
    });
    expect(second.data.queued).toMatchObject({ state: "queued" });

    const db = new Database(dbPath);
    try {
      const claimedAt = new Date().toISOString();
      db.query(`
        UPDATE session_queued_messages
        SET state = 'dispatching', claim_id = 'claim-before-turn',
          claim_owner = 'crashed-process', claimed_at = ?, lease_expires_at = ?
        WHERE client_message_id = ? AND state = 'queued'
      `).run(
        claimedAt,
        new Date(Date.now() + 60_000).toISOString(),
        "client-78787878-7878-4787-8787-787878787878",
      );
      const row = db.query<{ state: string; turn_id: string | null }, [string]>(`
        SELECT state, turn_id
        FROM session_queued_messages
        WHERE client_message_id = ?
      `).get("client-78787878-7878-4787-8787-787878787878");
      expect(row).toEqual({ state: "dispatching", turn_id: null });
    } finally {
      db.close();
    }

    server.stop();
    server = undefined;
    const expired = new Database(dbPath);
    try {
      expired.query(`
        UPDATE session_queued_messages
        SET lease_expires_at = ?
        WHERE client_message_id = ?
      `).run(
        new Date(Date.now() - 60_000).toISOString(),
        "client-78787878-7878-4787-8787-787878787878",
      );
    } finally {
      expired.close();
    }
    relaunched = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      inbound.poll(dispatchOptions);
      await inbound.waitForIdle();
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.query<{ state: string }, []>(`
          SELECT state
          FROM session_queued_messages
          WHERE chat_id = 'general'
          ORDER BY rowid ASC
        `).all();
        if (rows.length === 2 && rows.every((row) => row.state === "dispatched")) break;
      } finally {
        db.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await waitForQueueState(
      dbPath,
      "client-78787878-7878-4787-8787-787878787878",
      "dispatched",
    );
    const messages = await getJson(`${relaunched.url}messages?chat_id=general&cursor=0`);
    expect(messages.data.messages.filter((message: { role: string }) =>
      message.role === "user")).toHaveLength(2);
    expect(messages.data.messages.filter((message: { role: string; text: string }) =>
      message.role === "assistant" && message.text === "claim-only answer")).toHaveLength(2);
  } finally {
    if (relaunched) relaunched.stop();
    if (server) server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("production final projection rolls back on queue ack failure and replays one result", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-queued-input-result-commit-"));
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
    ownerId: "queued-input-result-commit-test",
    sessionBindings: bindings,
    modelRound: oneRoundAnswer("unused after result commit"),
  });
  let server: ReturnType<typeof createTestAppServer> | undefined = createTestAppServer({
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
  let relaunched: ReturnType<typeof createTestAppServer> | undefined;
  try {
    const accepted = await postMessage(server.url, {
      chat_id: "general",
      text: "result must survive a queue acknowledgement fault",
      client_message_id: "client-34343434-3434-4343-8343-343434343434",
    });
    const turnId = accepted.data.turn.id as string;
    const before = server.store.db.query<{
      claim_id: string | null;
      state: string;
    }, [string]>(`
      SELECT claim_id, state
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get("client-34343434-3434-4343-8343-343434343434");
    expect(before).toMatchObject({ state: "dispatching" });
    expect(before?.claim_id).toBeString();
    server.store.db.exec(`
      CREATE TRIGGER fail_app_queue_ack
      BEFORE UPDATE OF state ON session_queued_messages
      WHEN OLD.state = 'dispatching' AND NEW.state IN ('dispatched', 'failed')
      BEGIN
        SELECT RAISE(ABORT, 'fault queue acknowledgement');
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        while (server.store.syncNextAppTransportBatch()) {
          // Drain the bounded projection batch before retrying the fault cut.
        }
      } catch {
        // The injected acknowledgement fault is expected until the trigger is removed.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(server.store.db.query<{ state: string; claim_id: string | null }, [string]>(`
      SELECT state, claim_id
      FROM session_queued_messages
      WHERE client_message_id = ?
    `).get("client-34343434-3434-4343-8343-343434343434")).toEqual({
      state: "dispatching",
      claim_id: before!.claim_id,
    });
    expect(server.store.getTurn(turnId)).toMatchObject({ state: "thinking" });
    expect(server.store.listMessages("general").filter((message) =>
      message.role === "assistant",
    )).toHaveLength(0);

    // Stop immediately after the production transaction rolled back.  The
    // restart, rather than the same process, must replay the durable
    // transcript and complete the result/ack settlement.
    server.stop();
    server = undefined;
    const maintenanceDb = new Database(dbPath);
    try {
      maintenanceDb.exec("DROP TRIGGER fail_app_queue_ack");
    } finally {
      maintenanceDb.close();
    }
    relaunched = createTestAppServer({
      dbPath,
      butlerData: root,
      port: 0,
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
      await relaunched.store.waitForAppTransportProjection();
      while (relaunched.store.syncNextAppTransportBatch()) {
        // Drain the same production transcript/reconciliation path after restart.
      }
      const state = relaunched.store.db.query<{ state: string }, [string]>(`
        SELECT state FROM session_queued_messages
        WHERE client_message_id = ?
      `).get("client-34343434-3434-4343-8343-343434343434");
      if (state?.state === "dispatched") break;
    }
    expect(relaunched.store.listMessages("general").filter((message) =>
      message.role === "assistant",
    )).toHaveLength(1);
    expect(relaunched.store.getTurn(turnId)).toMatchObject({ state: "delivered" });
  } finally {
    if (server) server.stop();
    relaunched?.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

async function postMessage(url: string, body: Record<string, unknown>) {
  const response = await fetch(`${url}messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await response.json() as { data: Record<string, any> };
}

async function getJson(url: string) {
  const response = await fetch(url);
  return await response.json() as { data: Record<string, any> };
}

async function waitForAssistantMessage(url: string, text: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await getJson(`${url}messages?chat_id=general&cursor=0`);
    const message = (response.data.messages as Array<Record<string, unknown>>)
      .find((candidate) => candidate.role === "assistant" && candidate.text === text);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Assistant message did not appear: ${text}`);
}

async function waitForQueueState(
  dbPath: string,
  clientMessageId: string,
  state: string,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query<{ state: string }, [string]>(`
        SELECT state FROM session_queued_messages WHERE client_message_id = ?
      `).get(clientMessageId);
      if (row?.state === state) return;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query<unknown, []>("SELECT * FROM session_queued_messages").all();
    throw new Error(`Queue state did not become ${state}: ${JSON.stringify(rows)}`);
  } finally {
    db.close();
  }
}

function oneRoundAnswer(text: string): ModelRoundPort {
  return {
    async runRound() {
      return { text, toolCalls: [] };
    },
  };
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
