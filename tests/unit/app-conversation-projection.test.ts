import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import type {
  ConversationIdFactory,
} from "../../packages/butler-agent/src/agent/conversation/ids.ts";
import type {
  ConversationMessageWithParts,
  ConversationProjectionEvent,
  ConversationProjectionReader,
} from "../../packages/butler-agent/src/agent/conversation/types.ts";
import { AppServerStore } from "../../packages/butler-agent/src/gateways/app/application/store/app-server-store.ts";
import { sessionHintForRow } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import { BtccRecoveryCaseStore } from "../../packages/butler-agent/src/agent/turn/interruption/recovery-case-store.ts";
import {
  routeTurnInterruption,
  runtimeInterruptionFromUnknown,
} from "../../packages/butler-agent/src/agent/turn/interruption/turn-interruption-router.ts";

let tempDir = "";

function deterministicIds(): ConversationIdFactory {
  let next = 0;
  return (prefix) => `${prefix}_${String(++next).padStart(3, "0")}`;
}

function createConversationStore(): AgentConversationStore {
  return new AgentConversationStore({
    butlerData: tempDir,
    idFactory: deterministicIds(),
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-app-conversation-projection-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("app conversation projection replays canonical messages with refs idempotently", () => {
  const conversationStore = createConversationStore();
  const appStore = new AppServerStore({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    conversationProjectionReader: conversationStore,
  });
  const turn = conversationStore.beginTurn({
    gateway: "app",
    externalSessionId: "general",
    sessionId: "cs_app",
    actor: "user",
    turnId: "turn-1",
    now: "2026-07-02T00:00:00.000Z",
  });
  const existingUser = appStore.insertMessage("general", "user", "hello", "sent", {
    turnId: turn.id,
  });
  appStore.db.query(`
    INSERT INTO turns (
      id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
      retryable, cancellable, attempt, created_at, updated_at
    )
    VALUES (?, 'general', ?, 'delivered', 'Delivered', NULL, 0, 0, 1, ?, ?)
  `).run(
    turn.id,
    existingUser.id,
    "2026-07-02T00:00:00.000Z",
    "2026-07-02T00:00:00.000Z",
  );
  const user = conversationStore.appendUserMessage({
    sessionId: "cs_app",
    turnId: turn.id,
    text: "hello",
    now: "2026-07-02T00:00:01.000Z",
  });
  const assistant = conversationStore.appendAssistantMessage({
    sessionId: "cs_app",
    turnId: turn.id,
    text: "hi",
    now: "2026-07-02T00:00:02.000Z",
  });

  const firstReplay = appStore.replayConversationProjection();
  const secondReplay = appStore.replayConversationProjection();

  expect(firstReplay).toMatchObject({
    ok: true,
    processed: 4,
    projected_messages: 2,
    pending_count: 0,
  });
  expect(secondReplay).toMatchObject({
    ok: true,
    processed: 0,
    projected_messages: 0,
  });
  const messages = appStore.listMessages("general");
  const projectedMessages = appStore.listConversationProjectionMessages("cs_app");
  const projectedSession = appStore.getConversationProjectionSessionView("cs_app");
  const projectedBinding = appStore.getConversationProjectionBinding("cs_app");
  const projectedActivity = appStore.getConversationProjectionActivityState("cs_app");
  const chatRef = appStore.db.query<{ conversation_session_id: string | null }, [string]>(
    "SELECT conversation_session_id FROM chats WHERE id = ?",
  ).get("general");
  expect(messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    conversation_session_id: message.conversation_session_id,
    conversation_turn_id: message.conversation_turn_id,
    conversation_message_id: message.conversation_message_id,
  }))).toEqual([
    {
      id: existingUser.id,
      role: "user",
      text: "hello",
      conversation_session_id: "cs_app",
      conversation_turn_id: turn.id,
      conversation_message_id: user.id,
    },
    {
      id: `app-projection-${assistant.id}`,
      role: "assistant",
      text: "hi",
      conversation_session_id: "cs_app",
      conversation_turn_id: turn.id,
      conversation_message_id: assistant.id,
    },
  ]);
  expect(projectedMessages.map((message) => message.conversation_message_id)).toEqual([
    user.id,
    assistant.id,
  ]);
  expect(projectedSession?.session_id).toBe("general");
  expect(projectedBinding).toEqual({
    gateway: "app",
    external_session_id: "general",
    conversation_session_id: "cs_app",
  });
  expect(projectedActivity).toMatchObject({
    conversation_session_id: "cs_app",
    app_session_id: "general",
    latest_turn_state: "delivered",
    projection_pending_count: 0,
    safe_error_code: null,
  });
  expect(chatRef?.conversation_session_id).toBe("cs_app");

  const rebuilt = appStore.rebuildConversationProjection("cs_app");
  const userRowAfterRebuild = appStore.db.query<{
    conversation_message_id: string | null;
  }, [string]>(
    "SELECT conversation_message_id FROM messages WHERE id = ?",
  ).get(existingUser.id);
  const turnRowAfterRebuild = appStore.db.query<{
    user_message_id: string | null;
  }, [string]>(
    "SELECT user_message_id FROM turns WHERE id = ?",
  ).get(turn.id);
  expect(rebuilt).toMatchObject({
    ok: true,
    projected_messages: 2,
  });
  expect(userRowAfterRebuild?.conversation_message_id).toBe(user.id);
  expect(turnRowAfterRebuild?.user_message_id).toBe(existingUser.id);

  conversationStore.close();
  appStore.db.close();
});

test("app conversation projection reconciles runtime wait from durable turn truth", () => {
  const conversationStore = createConversationStore();
  const recoveryStore = new BtccRecoveryCaseStore({ butlerData: tempDir });
  const appStore = new AppServerStore({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    conversationProjectionReader: conversationStore,
  });
  const turn = conversationStore.beginTurn({
    gateway: "app",
    externalSessionId: "general",
    sessionId: "cs_runtime_wait",
    actor: "user",
    turnId: "turn-runtime-wait",
    now: "2026-07-16T00:00:00.000Z",
  });
  const user = appStore.insertMessage("general", "user", "do the work", "sent", {
    turnId: turn.id,
  });
  appStore.db.query(`
    INSERT INTO turns (
      id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
      retryable, cancellable, attempt, created_at, updated_at
    ) VALUES (?, 'general', ?, 'thinking', 'Thinking', NULL, 0, 1, 1, ?, ?)
  `).run(
    turn.id,
    user.id,
    "2026-07-16T00:00:00.000Z",
    "2026-07-16T00:00:00.000Z",
  );
  const admitted = recoveryStore.admitTurn({
    turnId: turn.id,
    sessionId: turn.session_id,
    attemptId: "attempt-runtime-wait",
    now: "2026-07-16T00:00:01.000Z",
  });
  const waiting = recoveryStore.applyDirective(routeTurnInterruption(runtimeInterruptionFromUnknown({
    error: new Error("provider schema rejected"),
    interruptionId: "interruption-runtime-wait",
    turnId: turn.id,
    attemptId: admitted.attemptId,
    origin: "phase_runtime",
    currentGeneration: admitted.generation,
    lastStableCheckpointRef: "checkpoint-conception-input",
    createdAt: "2026-07-16T00:00:02.000Z",
    sideEffectState: "known_not_applied",
    resumePredicateRef: "provider-schema-dialect-revision",
    diagnosticRefs: ["diagnostic-provider-schema"],
  })));

  const replay = appStore.replayConversationProjection();
  const projectedTurn = appStore.db.query<{
    state: string;
    safe_status_label: string;
    safe_error_code: string | null;
    retryable: number;
    cancellable: number;
  }, [string]>(`
    SELECT state, safe_status_label, safe_error_code, retryable, cancellable
    FROM turns
    WHERE id = ?
  `).get(turn.id);
  const view = appStore.getSessionView("general");

  expect(replay).toMatchObject({ ok: true, pending_count: 0 });
  expect(projectedTurn).toEqual({
    state: "waiting_runtime",
    safe_status_label: "Waiting for runtime recovery",
    safe_error_code: null,
    retryable: 0,
    cancellable: 1,
  });
  expect(view.status).toBe("active");
  expect(view.active_turn).toMatchObject({
    id: turn.id,
    state: "waiting_runtime",
    cancellable: true,
    retryable: false,
  });

  recoveryStore.applyDirective(routeTurnInterruption({
    schemaVersion: "butler.turn-interruption-envelope.v1",
    kind: "user_cancellation",
    interruptionId: "cancel-runtime-wait",
    turnId: turn.id,
    attemptId: admitted.attemptId,
    origin: "admission",
    currentGeneration: waiting.generation,
    lastStableCheckpointRef: "checkpoint-conception-input",
    createdAt: "2026-07-16T00:00:03.000Z",
    cancellationGeneration: waiting.generation,
    cancellationReceiptRef: "cancel-receipt-runtime-wait",
  }));
  const cancellationReplay = appStore.replayConversationProjection();
  const cancelledTurn = appStore.db.query<{
    state: string;
    cancellable: number;
  }, [string]>(`
    SELECT state, cancellable FROM turns WHERE id = ?
  `).get(turn.id);

  expect(cancellationReplay).toMatchObject({ ok: true, pending_count: 0 });
  expect(cancelledTurn).toEqual({ state: "cancelled", cancellable: 0 });
  expect(appStore.getSessionView("general").active_turn).toBeNull();
  expect(conversationStore.readTurn(turn.id)).toMatchObject({
    status: "aborted",
    completed_at: "2026-07-16T00:00:03.000Z",
  });
  expect(recoveryStore.readRecoveryCase(waiting.activeRecoveryCaseId!)).toMatchObject({
    status: "resolved",
    wakeRevisionRef: "cancel-receipt-runtime-wait",
  });

  appStore.db.close();
  recoveryStore.close();
  conversationStore.close();
});

test("app lifecycle projection rolls back state and cursor when its UI event cannot commit", () => {
  const conversationStore = createConversationStore();
  const recoveryStore = new BtccRecoveryCaseStore({ butlerData: tempDir });
  const appStore = new AppServerStore({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    conversationProjectionReader: conversationStore,
  });
  const turn = conversationStore.beginTurn({
    gateway: "app",
    externalSessionId: "general",
    sessionId: "cs_atomic_lifecycle",
    actor: "user",
    turnId: "turn-atomic-lifecycle",
    now: "2026-07-16T01:00:00.000Z",
  });
  const user = appStore.insertMessage("general", "user", "keep projection atomic", "sent", {
    turnId: turn.id,
  });
  appStore.db.query(`
    INSERT INTO turns (
      id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
      retryable, cancellable, attempt, created_at, updated_at
    ) VALUES (?, 'general', ?, 'thinking', 'Thinking', NULL, 0, 1, 1, ?, ?)
  `).run(
    turn.id,
    user.id,
    "2026-07-16T01:00:00.000Z",
    "2026-07-16T01:00:00.000Z",
  );
  const admitted = recoveryStore.admitTurn({
    turnId: turn.id,
    sessionId: turn.session_id,
    attemptId: "attempt-atomic-lifecycle",
    now: "2026-07-16T01:00:01.000Z",
  });
  recoveryStore.applyDirective(routeTurnInterruption(runtimeInterruptionFromUnknown({
    error: new Error("provider schema rejected"),
    interruptionId: "interruption-atomic-lifecycle",
    turnId: turn.id,
    attemptId: admitted.attemptId,
    origin: "phase_runtime",
    currentGeneration: admitted.generation,
    lastStableCheckpointRef: "checkpoint-atomic-lifecycle",
    createdAt: "2026-07-16T01:00:02.000Z",
    sideEffectState: "known_not_applied",
    resumePredicateRef: "provider-schema-dialect-revision",
    diagnosticRefs: [],
  })));
  appStore.db.exec(`
    CREATE TRIGGER reject_lifecycle_ui_event
    BEFORE INSERT ON events
    WHEN NEW.type = 'turn.state_changed'
    BEGIN
      SELECT RAISE(ABORT, 'injected lifecycle event failure');
    END
  `);

  const failedReplay = appStore.replayConversationProjection();
  expect(failedReplay).toMatchObject({
    ok: false,
    pending_count: 1,
    safe_error_code: "conversation_projection_failed",
  });
  expect(appStore.getTurn(turn.id)).toMatchObject({
    state: "thinking",
    safe_status_label: "Thinking",
  });

  appStore.db.exec("DROP TRIGGER reject_lifecycle_ui_event");
  const replayed = appStore.replayConversationProjection();
  expect(replayed).toMatchObject({ ok: true, pending_count: 0 });
  expect(appStore.getTurn(turn.id)).toMatchObject({
    state: "waiting_runtime",
    safe_status_label: "Waiting for runtime recovery",
  });

  appStore.db.close();
  recoveryStore.close();
  conversationStore.close();
});

test("app conversation projection resolves app runtime session hints to existing chats", () => {
  const conversationStore = createConversationStore();
  const appStore = new AppServerStore({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    conversationProjectionReader: conversationStore,
  });
  const appChatId = "project-sandy-bot-session";
  const runtimeSessionId = sessionHintForRow(appChatId);
  appStore.createSession({
    kind: "chat",
    title: "Sandy bot",
    session_hint: appChatId,
  });
  const turn = conversationStore.beginTurn({
    gateway: "app",
    externalSessionId: runtimeSessionId,
    sessionId: "cs_app_hint",
    actor: "user",
    turnId: "turn-hint",
    now: "2026-07-02T00:00:00.000Z",
  });
  const existingUser = appStore.insertMessage(appChatId, "user", "hello sandy", "sent", {
    turnId: turn.id,
  });
  appStore.db.query(`
    INSERT INTO turns (
      id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
      retryable, cancellable, attempt, created_at, updated_at
    )
    VALUES (?, ?, ?, 'delivered', 'Delivered', NULL, 0, 0, 1, ?, ?)
  `).run(
    turn.id,
    appChatId,
    existingUser.id,
    "2026-07-02T00:00:00.000Z",
    "2026-07-02T00:00:00.000Z",
  );
  const user = conversationStore.appendUserMessage({
    sessionId: "cs_app_hint",
    turnId: turn.id,
    text: "hello sandy",
    now: "2026-07-02T00:00:01.000Z",
  });
  const assistant = conversationStore.appendAssistantMessage({
    sessionId: "cs_app_hint",
    turnId: turn.id,
    text: "hi sandy",
    now: "2026-07-02T00:00:02.000Z",
  });

  const replay = appStore.replayConversationProjection();
  const runtimeChat = appStore.db.query<{ id: string }, [string]>(
    "SELECT id FROM chats WHERE id = ?",
  ).get(runtimeSessionId);
  const chatRef = appStore.db.query<{ conversation_session_id: string | null }, [string]>(
    "SELECT conversation_session_id FROM chats WHERE id = ?",
  ).get(appChatId);

  expect(replay).toMatchObject({
    ok: true,
    projected_messages: 2,
    pending_count: 0,
  });
  expect(runtimeChat).toBeNull();
  expect(chatRef?.conversation_session_id).toBe("cs_app_hint");
  expect(appStore.listMessages(appChatId).map((message) => ({
    id: message.id,
    chat_id: message.chat_id,
    conversation_message_id: message.conversation_message_id,
  }))).toEqual([
    {
      id: existingUser.id,
      chat_id: appChatId,
      conversation_message_id: user.id,
    },
    {
      id: `app-projection-${assistant.id}`,
      chat_id: appChatId,
      conversation_message_id: assistant.id,
    },
  ]);
  expect(appStore.getConversationProjectionSessionView("cs_app_hint")?.session_id)
    .toBe(appChatId);
  expect(appStore.getConversationProjectionBinding("cs_app_hint")).toEqual({
    gateway: "app",
    external_session_id: appChatId,
    conversation_session_id: "cs_app_hint",
  });
  expect(appStore.getConversationProjectionActivityState("cs_app_hint")).toMatchObject({
    conversation_session_id: "cs_app_hint",
    app_session_id: appChatId,
    latest_turn_state: "delivered",
  });

  const rebuilt = appStore.rebuildConversationProjection("cs_app_hint");
  expect(rebuilt).toMatchObject({
    ok: true,
    projected_messages: 2,
  });
  expect(appStore.db.query<{ id: string }, [string]>(
    "SELECT id FROM chats WHERE id = ?",
  ).get(runtimeSessionId)).toBeNull();

  conversationStore.close();
  appStore.db.close();
});

test("app conversation projection prunes empty runtime hint shadow rows after repair", () => {
  const conversationStore = createConversationStore();
  const appStore = new AppServerStore({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    conversationProjectionReader: conversationStore,
  });
  const appChatId = "project-existing-shadow";
  const runtimeSessionId = sessionHintForRow(appChatId);
  const now = "2026-07-02T00:00:00.000Z";
  appStore.createSession({
    kind: "chat",
    title: "Shadow owner",
    session_hint: appChatId,
  });
  const turn = conversationStore.beginTurn({
    gateway: "app",
    externalSessionId: runtimeSessionId,
    sessionId: "cs_shadow_repair",
    actor: "user",
    turnId: "turn-shadow",
    now,
  });
  const user = conversationStore.appendUserMessage({
    sessionId: "cs_shadow_repair",
    turnId: turn.id,
    text: "move me",
    now: "2026-07-02T00:00:01.000Z",
  });
  const assistant = conversationStore.appendAssistantMessage({
    sessionId: "cs_shadow_repair",
    turnId: turn.id,
    text: "moved",
    now: "2026-07-02T00:00:02.000Z",
  });
  const appUser = appStore.insertMessage(appChatId, "user", "move me", "sent", {
    turnId: turn.id,
  });
  const appAssistant = appStore.insertMessage(appChatId, "assistant", "moved", "delivered", {
    turnId: turn.id,
  });
  appStore.db.query(`
    INSERT INTO chats (
      id, title, kind, project_id, conversation_session_id, pinned, archived, created_at, updated_at
    )
    VALUES (?, 'Projected conversation', 'chat', NULL, 'cs_shadow_repair', 0, 0, ?, ?)
  `).run(runtimeSessionId, now, now);
  appStore.db.query(`
    INSERT INTO messages (
      id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
      conversation_message_id, role, text, status, created_at, updated_at,
      safe_error_code, retryable
    )
    VALUES (?, ?, ?, 'cs_shadow_repair', ?, ?, 'assistant', 'moved', 'delivered', ?, ?, NULL, 0)
  `).run(
    `app-projection-${assistant.id}`,
    runtimeSessionId,
    turn.id,
    turn.id,
    assistant.id,
    now,
    now,
  );
  appStore.db.query(`
    INSERT INTO messages (
      id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
      conversation_message_id, role, text, status, created_at, updated_at,
      safe_error_code, retryable
    )
    VALUES (?, ?, ?, 'cs_shadow_repair', ?, ?, 'user', 'move me', 'sent', ?, ?, NULL, 0)
  `).run(
    `app-projection-${user.id}`,
    runtimeSessionId,
    turn.id,
    turn.id,
    user.id,
    now,
    now,
  );

  const replay = appStore.replayConversationProjection();

  const shadowChat = appStore.db.query<{ conversation_session_id: string | null }, [string]>(
    "SELECT conversation_session_id FROM chats WHERE id = ?",
  ).get(runtimeSessionId);
  const shadowMessageCount = appStore.db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE chat_id = ?
      AND conversation_session_id = 'cs_shadow_repair'
  `).get(runtimeSessionId);
  expect(replay).toMatchObject({
    ok: true,
    projected_messages: 2,
  });
  expect(shadowChat).toBeNull();
  expect(shadowMessageCount?.count).toBe(0);
  expect(appStore.listSessions().sessions.some((session) =>
    session.id === runtimeSessionId,
  )).toBe(false);
  expect(appStore.getConversationProjectionBinding("cs_shadow_repair")).toEqual({
    gateway: "app",
    external_session_id: appChatId,
    conversation_session_id: "cs_shadow_repair",
  });
  expect(appStore.listConversationProjectionMessages("cs_shadow_repair").map((message) => ({
    id: message.id,
    chat_id: message.chat_id,
    conversation_message_id: message.conversation_message_id,
  }))).toEqual([
    { id: appUser.id, chat_id: appChatId, conversation_message_id: user.id },
    { id: appAssistant.id, chat_id: appChatId, conversation_message_id: assistant.id },
  ]);

  conversationStore.close();
  appStore.db.close();
});

test("app conversation projection rebuilds app rows from canonical rows without transcript", () => {
  const conversationStore = createConversationStore();
  const appStore = new AppServerStore({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    conversationProjectionReader: conversationStore,
  });
  const turn = conversationStore.beginTurn({
    gateway: "app",
    externalSessionId: "general",
    sessionId: "cs_rebuild",
    actor: "user",
    turnId: "turn-rebuild",
  });
  const user = conversationStore.appendUserMessage({
    sessionId: "cs_rebuild",
    turnId: turn.id,
    text: "rebuild me",
  });
  const assistant = conversationStore.appendAssistantMessage({
    sessionId: "cs_rebuild",
    turnId: turn.id,
    text: "rebuilt",
  });
  appStore.replayConversationProjection();
  appStore.insertMessage("general", "system_event", "activity stays app-only", "delivered");

  const rebuilt = appStore.rebuildConversationProjection("cs_rebuild");

  expect(rebuilt).toMatchObject({
    ok: true,
    conversation_session_id: "cs_rebuild",
    projected_messages: 2,
  });
  const messages = appStore.listMessages("general");
  expect(messages.map((message) => ({
    role: message.role,
    text: message.text,
    conversation_message_id: message.conversation_message_id,
  }))).toContainEqual(
    { role: "system_event", text: "activity stays app-only", conversation_message_id: undefined },
  );
  expect(messages.map((message) => ({
    role: message.role,
    text: message.text,
    conversation_message_id: message.conversation_message_id,
  }))).toEqual(expect.arrayContaining([
    { role: "user", text: "rebuild me", conversation_message_id: user.id },
    { role: "assistant", text: "rebuilt", conversation_message_id: assistant.id },
  ]));

  conversationStore.close();
  appStore.db.close();
});

test("app conversation projection failure leaves replay cursor retryable", () => {
  const failedEvent: ConversationProjectionEvent = {
    outbox_id: "cpo_missing",
    conversation_session_id: "cs_missing",
    seq: 1,
    kind: "conversation.message_committed",
    payload_ref: "cm_missing",
    created_at: "2026-07-02T00:00:00.000Z",
  };
  const reader: ConversationProjectionReader = {
    readProjectionBatch: () => [failedEvent],
    getSession: () => null,
    getGatewayBindingForConversation: () => null,
    readMessageById: () => null,
    readProjectionMessages: () => [],
  };
  const appStore = new AppServerStore({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    conversationProjectionReader: reader,
  });

  const result = appStore.replayConversationProjection();
  const status = appStore.getConversationProjectionStatus();

  expect(result).toMatchObject({
    ok: false,
    processed: 0,
    projected_messages: 0,
    last_outbox_id: null,
    pending_count: 1,
    safe_error_code: "conversation_projection_failed",
    failed_outbox_id: failedEvent.outbox_id,
  });
  expect(status).toMatchObject({
    last_outbox_id: null,
    pending_count: 1,
    safe_error_code: "conversation_projection_failed",
  });

  appStore.db.close();
});

test("app conversation projection keeps message event pending when app binding is missing", () => {
  const failedEvent: ConversationProjectionEvent = {
    outbox_id: "cpo_missing_binding",
    conversation_session_id: "cs_missing_binding",
    seq: 1,
    kind: "conversation.message_committed",
    payload_ref: "cm_missing_binding",
    created_at: "2026-07-02T00:00:00.000Z",
  };
  const message: ConversationMessageWithParts = {
    id: "cm_missing_binding",
    session_id: "cs_missing_binding",
    turn_id: "turn-missing-binding",
    seq: 1,
    role: "assistant",
    status: "complete",
    visibility: "model",
    provenance: "trusted",
    created_at: "2026-07-02T00:00:01.000Z",
    compacted_by_summary_id: null,
    source_gateway: "app",
    source_ref: null,
    parts: [{
      id: "cp_missing_binding",
      message_id: "cm_missing_binding",
      part_index: 0,
      kind: "text",
      content_json: { text: "project me later" },
      tool_call_id: null,
      parent_tool_call_id: null,
      provider_shape: null,
      status: "complete",
    }],
  };
  const reader: ConversationProjectionReader = {
    readProjectionBatch: () => [failedEvent],
    getSession: () => ({
      id: "cs_missing_binding",
      workspace_id: null,
      project_id: null,
      gateway_origin: "app",
      created_at: "2026-07-02T00:00:00.000Z",
      updated_at: "2026-07-02T00:00:00.000Z",
      status: "active",
      schema_version: 1,
    }),
    getGatewayBindingForConversation: () => null,
    readMessageById: () => message,
    readProjectionMessages: () => [message],
  };
  const appStore = new AppServerStore({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    conversationProjectionReader: reader,
  });

  const result = appStore.replayConversationProjection();
  const status = appStore.getConversationProjectionStatus();

  expect(result).toMatchObject({
    ok: false,
    processed: 0,
    projected_messages: 0,
    last_outbox_id: null,
    pending_count: 1,
    safe_error_code: "conversation_projection_failed",
    failed_outbox_id: failedEvent.outbox_id,
  });
  expect(status.last_outbox_id).toBeNull();

  appStore.db.close();
});

test("app server refresh replays canonical conversation outbox through the default reader", async () => {
  const conversationStore = createConversationStore();
  const turn = conversationStore.beginTurn({
    gateway: "app",
    externalSessionId: "general",
    sessionId: "cs_server",
    actor: "user",
    turnId: "turn-server",
  });
  conversationStore.appendUserMessage({
    sessionId: "cs_server",
    turnId: turn.id,
    text: "server hello",
  });
  const assistant = conversationStore.appendAssistantMessage({
    sessionId: "cs_server",
    turnId: turn.id,
    text: "server hi",
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    automationSchedulerIntervalMs: false,
  });

  try {
    const response = await fetch(`${server.url}messages?chat_id=general&cursor=0`);
    const body = await response.json() as {
      data: { messages: Array<{ text: string; conversation_message_id?: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.data.messages).toContainEqual(expect.objectContaining({
      text: "server hi",
      conversation_message_id: assistant.id,
    }));
    expect(server.store.getConversationProjectionStatus()).toMatchObject({
      pending_count: 0,
      safe_error_code: null,
    });
  } finally {
    server.stop();
    conversationStore.close();
  }
});

test("app conversation projection rebuild paginates canonical material and preserves attachments", () => {
  const totalMessages = 1205;
  const messages = Array.from({ length: totalMessages }, (_, index): ConversationMessageWithParts => {
    const seq = index + 1;
    return {
      id: `cm_many_${seq}`,
      session_id: "cs_many",
      turn_id: `turn-many-${seq}`,
      seq,
      role: seq % 2 === 0 ? "assistant" : "user",
      status: "complete",
      visibility: "model",
      provenance: "trusted",
      created_at: `2026-07-02T00:${String(seq % 60).padStart(2, "0")}:00.000Z`,
      compacted_by_summary_id: null,
      source_gateway: "app",
      source_ref: null,
      parts: [{
        id: `cp_many_${seq}`,
        message_id: `cm_many_${seq}`,
        part_index: 0,
        kind: "text",
        content_json: { text: `message ${seq}` },
        tool_call_id: null,
        parent_tool_call_id: null,
        provider_shape: null,
        status: "complete",
      }],
    };
  });
  const reader: ConversationProjectionReader = {
    readProjectionBatch: () => [],
    getSession: () => ({
      id: "cs_many",
      workspace_id: null,
      project_id: null,
      gateway_origin: "app",
      created_at: "2026-07-02T00:00:00.000Z",
      updated_at: "2026-07-02T00:00:00.000Z",
      status: "active",
      schema_version: 1,
    }),
    getGatewayBindingForConversation: () => ({
      gateway: "app",
      external_session_id: "general",
      conversation_session_id: "cs_many",
      created_at: "2026-07-02T00:00:00.000Z",
    }),
    readMessageById: (messageId) =>
      messages.find((message) => message.id === messageId) ?? null,
    readProjectionMessages: (_sessionId, input = {}) =>
      messages
        .filter((message) => message.seq > (input.afterSeq ?? 0))
        .slice(0, input.limit ?? 500),
  };
  const appStore = new AppServerStore({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    conversationProjectionReader: reader,
  });
  appStore.rebuildConversationProjection("cs_many");
  const uploaded = appStore.createMessageFile({
    ownerSessionId: "general",
    name: "result.txt",
    mimeType: "text/plain",
    bytes: "artifact bytes",
  });
  const attachedMessageId = "app-projection-cm_many_2";
  appStore.db.query(`
    INSERT INTO message_attachments (message_id, file_id, position)
    VALUES (?, ?, 0)
  `).run(attachedMessageId, uploaded.file.file_id);
  appStore.db.query("UPDATE message_files SET message_id = ? WHERE id = ?")
    .run(attachedMessageId, uploaded.file.file_id);

  const rebuilt = appStore.rebuildConversationProjection("cs_many");

  const count = appStore.db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE conversation_session_id = ?
  `).get("cs_many");
  const restored = appStore.listConversationProjectionMessages("cs_many")
    .find((message) => message.conversation_message_id === "cm_many_2");
  expect(rebuilt).toMatchObject({
    ok: true,
    conversation_session_id: "cs_many",
    projected_messages: totalMessages,
  });
  expect(count?.count).toBe(totalMessages);
  expect(restored?.attachments?.[0]?.file_id).toBe(uploaded.file.file_id);

  appStore.db.close();
});
