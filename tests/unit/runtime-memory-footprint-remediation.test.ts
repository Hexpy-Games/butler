import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { AppServerStore } from "../../packages/butler-agent/src/gateways/app/application/store/app-server-store.ts";
import { AgentConversationStore, conversationStorePath } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { createConversationProjectionReader } from "../../packages/butler-agent/src/agent/conversation/projection-reader.ts";
import { AppEventStore } from "../../packages/butler-agent/src/gateways/app/infrastructure/events/event-store.ts";
import { migrateAppStoreSchema, seedAppStoreDefaults } from "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import {
  APP_CACHE_BUDGET,
  cacheSnapshotBytes,
  trimCacheSnapshot,
} from "../../packages/butler-app/client/ui/src/app/cacheBudget.ts";
import sharedCacheBudget from "../../packages/butler-app/client/shared/cache-budget.json";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";
import { appendSnapshot } from "../../packages/butler-agent/src/agent/context/compaction-records.ts";
import { transcriptExportResponse } from "../../packages/butler-agent/src/gateways/app/interface/server/routes/session-view-routes.ts";
import {
  CONTEXT_DETAILS_MESSAGE_WINDOW_LIMIT,
  MAX_CONTEXT_DETAILS_CACHE_ENTRIES,
} from "../../packages/butler-agent/src/gateways/app/domain/sessions/context-details-store.ts";
import {
  encodeSessionCursor,
  SESSION_CURSOR_TTL_MS,
} from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-message-page.ts";
import { appendPromptCacheMetric } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import { readOperationalMetricSummary } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import {
  openOwnedSqliteConnection,
} from "../../packages/butler-agent/src/foundation/sqlite/owned-sqlite-connection.ts";
import { EMPTY_STEWARD_OBSERVER } from "./support/steward-observer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("session-view serves bounded cursor deltas and older pages without cross-session rows", async () => {
  const root = temporaryRoot();
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  try {
    const store = server.store as unknown as {
      insertMessage(chatId: string, role: string, text: string, status: string): { cursor?: number };
    };
    for (let index = 0; index < 205; index += 1) {
      store.insertMessage("general", "user", `message-${index}`, "delivered");
    }
    for (let index = 0; index < 40; index += 1) {
      appendSnapshot(root, "butler/app-general", {
        schema: "butler.context.compaction.v1",
        snapshot_id: `snapshot-${index}`,
        session_id: "butler/app-general",
        trigger: "auto",
        status: "ok",
        created_at: new Date(Date.now() + index).toISOString(),
        model_ref: null,
        model_context_window_tokens: 1,
        pre_estimated_tokens: 1,
        post_estimated_tokens: 1,
        summarized_event_range: {
          first_event_id: null,
          last_event_id: null,
          event_count: 0,
        },
        preserved_suffix_event_ids: [],
        summary: "",
        provenance: [],
        diagnostics: [],
      });
    }
    const initial = await json(`${server.url}session-view?session_id=general&limit=20`);
    expect(initial.data.messages).toHaveLength(20);
    expect(initial.data.message_window.complete).toBe(false);
    expect(initial.data.messages[0].text).toBe("message-185");
    expect(initial.data.messages.at(-1).text).toBe("message-204");
    const messageDelta = await json(`${server.url}messages?chat_id=general&cursor=1`);
    expect(messageDelta.data.messages).toHaveLength(200);
    expect(messageDelta.data.messages[0].text).toBe("message-1");
    expect(messageDelta.data.messages.at(-1).text).toBe("message-200");
    expect(messageDelta.data.next_cursor).toBeGreaterThan(1);
    const cursor = initial.data.message_window.next_cursor;
    const cursorToken = initial.data.message_window.next_cursor_token;
    expect(cursorToken).toEqual(expect.any(String));
    for (let index = 205; index < 208; index += 1) {
      store.insertMessage("general", "user", `message-${index}`, "delivered");
    }
    const exportResponse = await json(`${server.url}transcript-export?session_id=general`);
    expect(exportResponse.data.message_count).toBe(208);
    expect(exportResponse.data.content).toContain("message-0");
    expect(exportResponse.data.content).toContain("message-204");
    const delta = await json(
      `${server.url}session-view?session_id=general&cursor_token=${encodeURIComponent(cursorToken)}&limit=20`,
    );
    expect(delta.data.messages).toHaveLength(3);
    expect(delta.data.messages.every((message: { cursor: number }) => message.cursor > cursor)).toBe(true);
    expect(delta.data.message_window.requested_cursor).toBe(cursor);
    expect(delta.data.message_window.complete).toBe(true);
    const tokenDelta = await json(
      `${server.url}session-view?session_id=general&cursor_token=${encodeURIComponent(cursorToken)}&limit=20`,
    );
    expect(tokenDelta.data.messages.map((message: { id: string }) => message.id)).toEqual(
      delta.data.messages.map((message: { id: string }) => message.id),
    );
    const olderToken = initial.data.message_window.previous_cursor_token;
    expect(olderToken).toEqual(expect.any(String));
    const older = await json(
      `${server.url}session-view?session_id=general&before_cursor_token=${encodeURIComponent(olderToken)}&limit=20`,
    );
    expect(older.data.messages.length).toBeLessThanOrEqual(20);
    expect(older.data.messages.length).toBeGreaterThan(0);
    expect(older.data.messages.every((message: { cursor: number }) => message.cursor < cursor)).toBe(true);
    expect(older.data.messages.at(-1).cursor).toBeLessThan(cursor);
    const invalid = await fetch(
      `${server.url}session-view?session_id=general&cursor_token=invalid`,
    );
    expect(invalid.status).toBe(409);
    const invalidBody = await invalid.json() as { error?: { code?: string } };
    expect(invalidBody.error?.code).toBe("session_cursor_resync_required");

    for (const rawCursor of ["cursor=1", "after_cursor=1", "before_cursor=1"] as const) {
      const raw = await fetch(`${server.url}session-view?session_id=general&${rawCursor}`);
      expect(raw.status).toBe(409);
      const body = await raw.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe("session_cursor_resync_required");
    }

    const foreign = await fetch(
      `${server.url}session-view?session_id=another-session&cursor_token=${encodeURIComponent(cursorToken)}`,
    );
    expect(foreign.status).toBe(409);
    expect((await foreign.json()).error.code).toBe("session_cursor_resync_required");

    const expiredToken = encodeSessionCursor(
      "general",
      cursor,
      Date.now() - SESSION_CURSOR_TTL_MS - 1,
    );
    const expired = await fetch(
      `${server.url}session-view?session_id=general&cursor_token=${encodeURIComponent(expiredToken)}`,
    );
    expect(expired.status).toBe(409);
    expect((await expired.json()).error.code).toBe("session_cursor_resync_required");
  } finally {
    server.stop();
  }
});

test("context-details uses a small recent-message window instead of rematerializing the session page", async () => {
  const root = temporaryRoot();
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  try {
    const store = server.store as unknown as {
      insertMessage(
        chatId: string,
        role: string,
        text: string,
        status: string,
      ): unknown;
      kernel: {
        contextDetails: {
          sessionViewMessages: (
            sessionId: string,
            options?: { limit?: number },
          ) => unknown;
        };
      };
    };
    for (let index = 0; index < 220; index += 1) {
      store.insertMessage(
        "general",
        index % 2 === 0 ? "user" : "assistant",
        `large-history-${index}-${"x".repeat(256)}`,
        "delivered",
      );
    }
    const contextStore = store.kernel.contextDetails;
    const original = contextStore.sessionViewMessages;
    let observedLimit: number | undefined;
    contextStore.sessionViewMessages = (sessionId, options) => {
      observedLimit = options?.limit;
      return original.call(contextStore, sessionId, options);
    };

    const response = await json(`${server.url}context-details?session_id=general`);
    expect(response.data.session_id).toBe("general");
    expect(observedLimit).toBe(CONTEXT_DETAILS_MESSAGE_WINDOW_LIMIT);
    expect(response.data.token_count_source).toBe("character_estimate");
  } finally {
    server.stop();
  }
});

test("session artifact and context reference reads avoid full transcript/file materialization", async () => {
  const root = temporaryRoot();
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  try {
    const store = server.store as unknown as {
      kernel: {
        sessionRecords: {
          listMessages: (...args: unknown[]) => unknown;
        };
        messageFiles: {
          refsForSession: (...args: unknown[]) => unknown;
        };
        sessionViews: {
          listArtifacts: (sessionId: string) => unknown;
        };
      };
    };
    const sessionRecords = store.kernel.sessionRecords;
    const messageFiles = store.kernel.messageFiles;
    const originalListMessages = sessionRecords.listMessages.bind(sessionRecords);
    const originalRefsForSession = messageFiles.refsForSession.bind(messageFiles);
    let listMessagesCalls = 0;
    let refsForSessionCalls = 0;
    sessionRecords.listMessages = (...args) => {
      listMessagesCalls += 1;
      return originalListMessages(...args);
    };
    messageFiles.refsForSession = (...args) => {
      refsForSessionCalls += 1;
      return originalRefsForSession(...args);
    };

    store.kernel.sessionViews.listArtifacts("general");
    await json(`${server.url}context-details?session_id=general`);

    expect(listMessagesCalls).toBe(0);
    expect(refsForSessionCalls).toBe(0);
  } finally {
    server.stop();
  }
});

test("context details memoizes one revision, invalidates on message/settings/metric changes, and evicts bounded sessions", () => {
  const root = temporaryRoot();
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  try {
    const store = server.store as unknown as {
      insertMessage(
        chatId: string,
        role: string,
        text: string,
        status: string,
      ): unknown;
      getContextDetails(sessionId: string): unknown;
      createSession(input: { kind: "chat"; title: string }): { session: { id: string } };
      updateSettings(input: Record<string, unknown>): unknown;
      insertTurn(
        chatId: string,
        state: string,
        safeStatusLabel: string,
      ): { id: string };
      updateTurnState(
        turnId: string,
        state: string,
        options: { safeStatusLabel: string; cancellable?: boolean },
      ): unknown;
      kernel: {
        contextDetails: {
          sessionViewMessages: (...args: unknown[]) => unknown;
          listArtifacts: (...args: unknown[]) => unknown;
          contextDetailsCache: Map<string, unknown>;
        };
      };
    };
    const contextStore = store.kernel.contextDetails;
    const originalMessages = contextStore.sessionViewMessages.bind(contextStore);
    const originalArtifacts = contextStore.listArtifacts.bind(contextStore);
    let messageReads = 0;
    let artifactReads = 0;
    contextStore.sessionViewMessages = (...args) => {
      messageReads += 1;
      return originalMessages(...args);
    };
    contextStore.listArtifacts = (...args) => {
      artifactReads += 1;
      return originalArtifacts(...args);
    };

    store.getContextDetails("general");
    store.getContextDetails("general");
    expect(messageReads).toBe(1);
    expect(artifactReads).toBe(1);

    store.insertMessage("general", "user", "revision-message", "delivered");
    store.getContextDetails("general");
    expect(messageReads).toBe(2);
    expect(artifactReads).toBe(2);

    const turn = store.insertTurn("general", "accepted", "Accepted");
    store.getContextDetails("general");
    expect(messageReads).toBe(3);
    expect(artifactReads).toBe(3);
    store.updateTurnState(turn.id, "thinking", {
      safeStatusLabel: "Thinking",
      cancellable: true,
    });
    store.getContextDetails("general");
    expect(messageReads).toBe(4);
    expect(artifactReads).toBe(4);

    store.updateSettings({ language: "ko" });
    store.getContextDetails("general");
    expect(messageReads).toBe(5);
    expect(artifactReads).toBe(5);

    appendPromptCacheMetric(
      {
        ts: Date.now(),
        model: "openai/gpt-5.5",
        scope: "btcc-guided:butler/app-general",
        promptTokens: 64,
        cachedTokens: 0,
      },
      { butlerData: root },
    );
    store.getContextDetails("general");
    expect(messageReads).toBe(6);
    expect(artifactReads).toBe(6);

    for (let index = 0; index < MAX_CONTEXT_DETAILS_CACHE_ENTRIES + 4; index += 1) {
      const session = store.createSession({
        kind: "chat",
        title: `memo-session-${index}`,
      }).session;
      store.getContextDetails(session.id);
    }
    expect(contextStore.contextDetailsCache.size).toBeLessThanOrEqual(8);
  } finally {
    server.stop();
  }
});

test("app read polling does not retain gateway-owned SQLite statements", () => {
  const root = temporaryRoot();
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  try {
    const store = server.store as unknown as {
      insertMessage(
        chatId: string,
        role: string,
        text: string,
        status: string,
      ): unknown;
      getSessionView(sessionId: string, options?: { limit?: number }): unknown;
      kernel: {
        dbConnection: {
          statementCacheSize(): number;
        };
      };
    };
    for (let index = 0; index < 220; index += 1) {
      store.insertMessage(
        "general",
        index % 2 === 0 ? "user" : "assistant",
        `polling-fixture-${index}`,
        "delivered",
      );
    }
    for (let index = 0; index < 768; index += 1) {
      store.getSessionView("general", { limit: 64 });
    }
    expect(store.kernel.dbConnection.statementCacheSize()).toBe(0);
  } finally {
    server.stop();
  }
});

test("AppServerStore.close stops projection timers before closing its database", async () => {
  const root = temporaryRoot();
  const store = new AppServerStore({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    butlerHome: root,
    stewardObserver: EMPTY_STEWARD_OBSERVER,
  });
  store.close();
  await Bun.sleep(100);
  const summary = readOperationalMetricSummary({ butlerData: root });
  expect(summary.byName["app.transport_projection"]?.errors ?? 0).toBe(0);
});

test("conversation projection reader opens while the Agent writer owns a write transaction", () => {
  const root = temporaryRoot();
  const writer = new AgentConversationStore({ butlerData: root });
  const writerLock = new Database(conversationStorePath(root));
  writerLock.exec("BEGIN IMMEDIATE");
  let managedReader: ReturnType<typeof createConversationProjectionReader> | undefined;
  try {
    expect(() => {
      managedReader = createConversationProjectionReader({ butlerData: root });
      managedReader.reader.readProjectionBatch(null);
    }).not.toThrow();
  } finally {
    managedReader?.close();
    writerLock.exec("ROLLBACK");
    writerLock.close();
    writer.close();
  }
});

test("conversation projection reader stays lazy until the canonical database appears", () => {
  const root = temporaryRoot();
  const managedReader = createConversationProjectionReader({ butlerData: root });
  const dbPath = conversationStorePath(root);
  try {
    expect(existsSync(dbPath)).toBe(false);
    expect(managedReader.reader.isAvailable?.()).toBe(false);
    expect(managedReader.reader.readProjectionBatch(null)).toEqual([]);

    const writer = new AgentConversationStore({ butlerData: root });
    expect(managedReader.reader.isAvailable?.()).toBe(true);
    const turn = writer.beginTurn({
      gateway: "app",
      externalSessionId: "lazy-reader",
      sessionId: "session-lazy-reader",
      actor: "user",
    });
    const request = writer.appendUserMessage({
      sessionId: turn.session_id,
      turnId: turn.id,
      text: "projection reader contract",
    });
    writer.finalizeTurn({
      turnId: turn.id,
      status: "failed",
      outcomeCapsule: {
        sessionId: turn.session_id,
        turnId: turn.id,
        generation: 1,
        outcome: "failed",
        requestMessageId: request.id,
        safeCode: "fixture_failure",
      },
    });
    expect(managedReader.reader.getSession(turn.session_id)?.id).toBe(turn.session_id);
    expect(managedReader.reader.getGatewayBindingForConversation(turn.session_id, "app"))
      .toMatchObject({ external_session_id: "lazy-reader" });
    expect(managedReader.reader.readProjectionBatch(null)).not.toHaveLength(0);
    expect(managedReader.reader.readProjectionMessages(turn.session_id)).toHaveLength(1);
    expect(managedReader.reader.readMessageById(request.id)?.id).toBe(request.id);
    const outcome = managedReader.reader.readTurnOutcome(turn.id);
    expect(outcome?.outcome).toBe("failed");
    expect(managedReader.reader.readTurnOutcomeById(outcome!.id)?.turn_id).toBe(turn.id);
    expect(managedReader.reader.readTurnOutcomes(null)).toHaveLength(1);
    managedReader.close();
    expect(managedReader.reader.isAvailable?.()).toBe(false);
    expect(managedReader.reader.readProjectionBatch(null)).toEqual([]);
    writer.close();
  } finally {
    managedReader.close();
  }
});

test("App Gateway remains available before and after the Agent creates canonical storage", () => {
  const root = temporaryRoot();
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  try {
    expect(server.store.replayConversationProjection()).toMatchObject({
      ok: true,
      processed: 0,
      projected_messages: 0,
    });

    const writer = new AgentConversationStore({ butlerData: root });
    writer.beginTurn({
      gateway: "app",
      externalSessionId: "app-recovery",
      sessionId: "session-app-recovery",
      actor: "user",
    });
    writer.close();
    expect(server.store.replayConversationProjection()).toMatchObject({
      ok: true,
      processed: 0,
      projected_messages: 0,
    });
  } finally {
    server.stop();
  }
});

test("owned SQLite does not finalize an active iterator during nested queries", () => {
  const connection = openOwnedSqliteConnection(":memory:");
  let first: Iterator<unknown> | undefined;
  try {
    connection.database.run("CREATE TABLE values_fixture (value INTEGER)");
    connection.database.run(
      "INSERT INTO values_fixture (value) VALUES (1), (2), (3), (4)",
    );
    const active = connection.database
      .query("SELECT value FROM values_fixture ORDER BY value")
      .iterate();
    first = active;
    expect(active.next().value).toEqual({ value: 1 });
    for (let index = 0; index < 300; index += 1) {
      connection.database.query(`SELECT ${index}`).get();
    }
    expect(active.next().value).toEqual({ value: 2 });
    expect(connection.statementCacheSize()).toBe(0);
  } finally {
    if (first) {
      while (!first.next().done) {
        // Exhaust Bun's iterator before closing the owning database.
      }
    }
    connection.close();
  }
});

test("transcript export pulls one bounded chunk at a time and closes the iterator on cancellation", async () => {
  let nextCalls = 0;
  let returnCalls = 0;
  const chunks = {
    next() {
      nextCalls += 1;
      if (nextCalls > 4) return { done: true, value: undefined };
      return { done: false, value: { text: `chunk-${nextCalls}`, message_count: nextCalls === 4 ? 1 : 0 } };
    },
    return() {
      returnCalls += 1;
      return { done: true, value: undefined };
    },
    [Symbol.iterator]() {
      return this;
    },
  } as unknown as Iterable<{ text: string; message_count?: number }>;
  const response = transcriptExportResponse({
    session_id: "stream-session",
    format: "markdown",
    filename: "stream-session.md",
    generated_at: "2026-08-12T00:00:00.000Z",
    chunks,
  });
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(nextCalls).toBe(0);
  const second = await reader.read();
  expect(second.done).toBe(false);
  expect(nextCalls).toBe(1);
  await reader.cancel("slow consumer stopped");
  expect(returnCalls).toBe(1);
  expect(nextCalls).toBeLessThanOrEqual(1);
});

test("event retention keeps canonical messages and active turn recovery while deleting compactable history in batches", () => {
  const db = new Database(":memory:");
  migrateAppStoreSchema(db);
  seedAppStoreDefaults(db);
  const events = new AppEventStore(db, undefined, {
    maxRows: 4,
    maxAgeMs: 0,
    deleteBatchSize: 2,
    liveReplayTail: 2,
  });
  events.append("runtime.noise", { detail: "one" });
  events.append("agent.turn_event", { turn_id: "active-turn", event: {} });
  events.append("runtime.noise", { detail: "two" });
  events.append("runtime.noise", { detail: "three" });
  events.append("runtime.noise", { detail: "four" });
  events.append("message.created", { message: { id: "canonical" } });
  events.append("runtime.noise", { detail: "five" });
  events.append("runtime.noise", { detail: "six" });
  events.append("runtime.recoverable_evidence", {
    turn_id: "recoverable-turn",
    detail: "retryable runtime fault",
  });
  events.append("agent.turn_event", {
    turn_id: "terminal-turn",
    event: { type: "turn.completed" },
  });
  events.append("agent.turn_event.progress", {
    turn_id: "terminal-turn",
    row: { id: "terminal-progress", label: "done", status: "completed" },
  });
  events.append("progress.summary", {
    turn_id: "terminal-turn",
    row: { id: "terminal-summary", label: "done", status: "completed" },
  });
  db.query("INSERT INTO turns (id, chat_id, state, safe_status_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "active-turn",
    "general",
    "thinking",
    "Thinking",
    new Date(0).toISOString(),
    new Date(0).toISOString(),
  );
  db.query("INSERT INTO turns (id, chat_id, state, safe_status_label, retryable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "recoverable-turn",
    "general",
    "runtime_fault",
    "Retryable runtime failure",
    1,
    new Date(0).toISOString(),
    new Date(0).toISOString(),
  );
  db.query("INSERT INTO turns (id, chat_id, state, safe_status_label, retryable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "terminal-turn",
    "general",
    "delivered",
    "Delivered",
    0,
    new Date(0).toISOString(),
    new Date(0).toISOString(),
  );
  for (let index = 0; index < 5; index += 1) {
    events.append("runtime.noise_after_recoverable", { index });
  }
  expect(events.compact(new Date(Date.now() + 1_000))).toMatchObject({ deleted: expect.any(Number) });
  expect(db.query("SELECT type FROM events WHERE type = 'message.created'").all()).toHaveLength(1);
  expect(db.query("SELECT type FROM events WHERE turn_id = 'active-turn'").all()).toHaveLength(1);
  expect(db.query("SELECT type FROM events WHERE turn_id = 'recoverable-turn'").all()).toHaveLength(1);
  expect(db.query("SELECT type FROM events WHERE turn_id = 'terminal-turn' AND type IN ('agent.turn_event', 'agent.turn_event.progress', 'progress.summary')").all()).toHaveLength(3);
  db.close();
});

test("event retention applies age-only and count-only bounds in resumable batches", () => {
  const ageDb = new Database(":memory:");
  migrateAppStoreSchema(ageDb);
  seedAppStoreDefaults(ageDb);
  const ageEvents = new AppEventStore(ageDb, undefined, {
    maxRows: 1_000,
    maxAgeMs: 1,
    deleteBatchSize: 2,
    liveReplayTail: 2,
  });
  for (let index = 0; index < 6; index += 1) {
    ageEvents.append("runtime.old_noise", { index });
  }
  ageEvents.append("message.created", { message: { id: "age-canonical" } });
  const aged = ageEvents.compact(new Date(Date.now() + 1_000));
  expect(aged.deleted).toBe(2);
  expect(aged.remainingCompactable).toBe(true);
  while (ageEvents.compact(new Date(Date.now() + 1_000)).remainingCompactable) {
    // Each call deletes one bounded batch; a later call resumes from the
    // durable event table without retaining a candidate queue in memory.
  }
  expect(ageDb.query("SELECT type FROM events WHERE type = 'message.created'").all()).toHaveLength(1);
  expect(
    ageDb.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check,
  ).toBe("ok");
  ageDb.close();

  const countDb = new Database(":memory:");
  migrateAppStoreSchema(countDb);
  seedAppStoreDefaults(countDb);
  const countEvents = new AppEventStore(countDb, undefined, {
    maxRows: 10,
    maxAgeMs: 365 * 24 * 60 * 60 * 1_000,
    deleteBatchSize: 3,
    liveReplayTail: 2,
  });
  for (let index = 0; index < 40; index += 1) {
    countEvents.append("runtime.fresh_noise", { index });
  }
  countEvents.append("message.created", { message: { id: "count-canonical" } });
  const counted = countEvents.compact(new Date());
  expect(counted.deleted).toBe(3);
  expect(counted.remainingCompactable).toBe(true);
  let result = counted;
  while (result.remainingCompactable) result = countEvents.compact(new Date());
  expect(countDb.query("SELECT type FROM events WHERE type = 'message.created'").all()).toHaveLength(1);
  expect(
    countDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count,
  ).toBeLessThanOrEqual(12);
  expect(
    countDb.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check,
  ).toBe("ok");
  countDb.close();
});

test("shared app cache budget rejects oversized snapshots and trims deterministic oldest rows", () => {
  expect(APP_CACHE_BUDGET).toEqual({
    maxEntries: sharedCacheBudget.maxEntries,
    maxBytes: sharedCacheBudget.maxBytes,
    maxSnapshotBytes: sharedCacheBudget.maxSnapshotBytes,
    maxMessages: sharedCacheBudget.maxMessages,
    maxComposerDraftBytes: sharedCacheBudget.maxComposerDraftBytes,
    maxComposerDraftEntries: sharedCacheBudget.maxComposerDraftEntries,
    maxComposerDraftAggregateBytes: sharedCacheBudget.maxComposerDraftAggregateBytes,
  });
  const messages = Array.from({ length: APP_CACHE_BUDGET.maxMessages + 20 }, (_, index) => ({
    id: `message-${index}`,
    chat_id: "general",
    role: "user",
    text: `message-${index}`,
    cursor: index + 1,
  }));
  const bounded = trimCacheSnapshot({
    schema: "butler.message-cache.v1",
    chat_id: "general",
    messages,
    turn_progress: {},
    next_cursor: messages.length,
    cached_at: "2026-08-12T00:00:00.000Z",
  });
  expect(bounded?.messages.length).toBeLessThanOrEqual(APP_CACHE_BUDGET.maxMessages);
  expect(cacheSnapshotBytes(bounded)).toBeLessThanOrEqual(APP_CACHE_BUDGET.maxSnapshotBytes);
});

test("renderer cache evicts least-recently-used completed sessions under the shared entry budget", async () => {
  const items = new Map<string, string>();
  const previousStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return items.size;
      },
      key: (index: number) => [...items.keys()][index] ?? null,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    },
  });
  try {
    const cache = await import(
      `../../packages/butler-app/client/ui/src/app/messageCache.ts?rmf=${Date.now()}`,
    );
    for (let index = 0; index < APP_CACHE_BUDGET.maxEntries + 2; index += 1) {
      await cache.writeCachedMessageList(`session-${index}`, {
        chat_id: `session-${index}`,
        messages: [
          {
            id: `message-${index}`,
            chat_id: `session-${index}`,
            role: "user",
            text: "bounded",
            cursor: index + 1,
            status: "delivered",
          },
        ],
      });
    }
    expect(items.has("butler:message-cache:v1:session-0")).toBe(false);
    expect(items.has("butler:message-cache:v1:session-1")).toBe(false);
    expect(items.size).toBeLessThanOrEqual(APP_CACHE_BUDGET.maxEntries);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: previousStorage,
    });
  }
});

test("Zustand session snapshots touch LRU order without evicting the active session", () => {
  const state = useButlerStore.getState();
  const previous = {
    activeChatId: state.activeChatId,
    messages: state.messages,
    turnProgress: state.turnProgress,
    sessionMessageViews: state.sessionMessageViews,
  };
  try {
    useButlerStore.setState({
      activeChatId: "active-session",
      messages: [],
      turnProgress: {},
      sessionMessageViews: {},
    });
    for (let index = 0; index < APP_CACHE_BUDGET.maxEntries; index += 1) {
      useButlerStore.getState().setMessageListView({
        chat_id: `session-${index}`,
        messages: [
          {
            id: `message-${index}`,
            chat_id: `session-${index}`,
            role: "user",
            text: "bounded",
            status: "delivered",
            retryable: false,
            cursor: index + 1,
            created_at: "2026-08-12T00:00:00.000Z",
            updated_at: "2026-08-12T00:00:00.000Z",
          },
        ],
      });
    }
    // Re-submit an unchanged view to mark it recently used, then force one
    // eviction. The oldest untouched session, not session-0, must leave.
    useButlerStore.getState().setMessageListView({
      chat_id: "session-0",
      messages: [
        {
          id: "message-0",
          chat_id: "session-0",
          role: "user",
          text: "bounded",
          status: "delivered",
          retryable: false,
          cursor: 1,
          created_at: "2026-08-12T00:00:00.000Z",
          updated_at: "2026-08-12T00:00:00.000Z",
        },
      ],
    });
    useButlerStore.getState().setMessageListView({
      chat_id: "session-new",
      messages: [
        {
          id: "message-new",
          chat_id: "session-new",
          role: "user",
          text: "bounded",
          status: "delivered",
          retryable: false,
          cursor: 999,
          created_at: "2026-08-12T00:00:00.000Z",
          updated_at: "2026-08-12T00:00:00.000Z",
        },
      ],
    });
    const views = useButlerStore.getState().sessionMessageViews;
    expect(Object.keys(views)).toHaveLength(APP_CACHE_BUDGET.maxEntries);
    expect(views["session-0"]).toBeDefined();
    expect(views["session-1"]).toBeUndefined();
  } finally {
    useButlerStore.setState(previous);
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "butler-rmf-"));
  roots.push(root);
  return root;
}

async function json(url: string): Promise<any> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}
