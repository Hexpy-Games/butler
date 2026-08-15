import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { RuntimeTurnEventInput } from
  "../../packages/butler-agent/src/agent/events/turn-events.ts";
import type { ChatRow, MessageRow, TurnRow } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/core/records.ts";
import type { TranscriptEvent } from
  "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import {
  appendTranscript,
  cleanupTranscriptProjectionHarnesses,
  createTranscriptProjectionHarness as createHarness,
  writeTranscript,
} from "./support/transcript-projection-harness.ts";
import { AppMessageFileStore } from
  "../../packages/butler-agent/src/gateways/app/domain/message-files/message-file-store.ts";
import { executeGuidedReadOnlyCommand } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-read-only-command.ts";
import { collectGuidedFinalArtifacts } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-final-artifacts.ts";

afterEach(() => cleanupTranscriptProjectionHarnesses());

test("delivered turn event directly projects the canonical BTCC answer", () => {
  const harness = createHarness();
  seedBtccTerminalSchema(harness.db);
  seedAppTurn(harness.db, harness.chatId, "live-delivered-turn");
  seedCanonicalDelivery(
    harness.db,
    "live-delivered-turn",
    "live-outbox",
    "live-message",
    "Canonical answer",
  );
  const state = projectionState(harness.db);
  const projection = harness.createProjectionStore(state.options);
  writeTranscript(harness, terminalTurnEvents({
    actionId: "live-completed-event",
    turnId: "live-delivered-turn",
    kind: "turn.completed",
  }));

  expect(projection.syncNextBatch()).toBe(false);
  expect(turnState(harness.db, "live-delivered-turn")).toBe("delivered");
  expect(state.assistant?.text).toBe("Canonical answer");
  expect(state.assistantWrites).toBe(1);
  expect(state.turnEvents).toContain("turn.completed");
  expect(harness.projected()).toEqual([]);
  expect(projectedReceipt(harness.db, "live-completed-event")).toBe(true);
  expect(projectedReceipt(
    harness.db,
    "btcc-canonical-final:live-outbox",
  )).toBe(true);

  appendTranscript(harness, finalResultEvent({
    actionId: "late-identical-final",
    turnId: "live-delivered-turn",
    text: "Canonical answer",
    generatedSessionTitle: "Useful title",
  }));
  expect(projection.syncNextBatch()).toBe(false);
  expect(state.generatedTitles).toEqual(["Useful title"]);
  expect(state.assistantWrites).toBe(1);

  appendTranscript(harness, finalResultEvent({
    actionId: "late-conflicting-final",
    turnId: "live-delivered-turn",
    text: "Conflicting answer",
    generatedSessionTitle: "Rejected title",
  }));
  expect(projection.syncNextBatch()).toBe(false);
  expect(state.generatedTitles).toEqual(["Useful title"]);
  expect(state.assistant?.text).toBe("Canonical answer");
  expect(state.assistantWrites).toBe(1);
  harness.close();
});

test("guided read-only workspace outputs create real App attachments", async () => {
  const harness = createHarness();
  seedBtccTerminalSchema(harness.db);
  seedAppTurn(harness.db, harness.chatId, "live-artifact-turn");
  const workspace = join(harness.root, "workspace");
  const sourceDir = join(workspace, ".sandy-data", "poc", "vision-crop");
  mkdirSync(sourceDir, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3f4AAAAASUVORK5CYII=",
    "base64",
  );
  writeFileSync(join(sourceDir, "page.png"), png);
  writeFileSync(join(sourceDir, "crop.png"), png);
  const guidedResult = await executeGuidedReadOnlyCommand({
    args: {
      command: "test -f .sandy-data/poc/vision-crop/page.png && test -f .sandy-data/poc/vision-crop/crop.png",
      cwd: workspace,
      state_effect: "read_only",
      output_paths: [
        ".sandy-data/poc/vision-crop/page.png",
        ".sandy-data/poc/vision-crop/crop.png",
      ],
    },
    butlerData: harness.root,
    workspacePath: workspace,
    originalRequest: "이미지가 안보였어 한번만 다시 첨부해줄래?",
  });
  if (process.platform !== "darwin") {
    harness.close();
    return;
  }
  expect(guidedResult).toMatchObject({
    ok: true,
    artifact_publication: { requested: 2, published: 2 },
  });
  const finalArtifacts = collectGuidedFinalArtifacts([{
    callId: "sandy-read-only-attachment",
    toolName: "run_command",
    rawArguments: "{}",
    arguments: {},
    status: "completed",
    result: guidedResult,
  }]);
  expect(finalArtifacts.map((artifact) => artifact.title)).toEqual([
    "page.png",
    "crop.png",
  ]);
  const messageFiles = new AppMessageFileStore(
    harness.db,
    harness.root,
    () => undefined,
  );
  let assistant: MessageRow | null = null;
  let writes = 0;
  const state = projectionState(harness.db);
  const projection = harness.createProjectionStore({
    ...state.options,
    messageFiles,
    getChatRow: (chatId) => harness.db.query<ChatRow, [string]>(
      "SELECT rowid, * FROM chats WHERE id = ?",
    ).get(chatId),
    getProjectRow: () => null,
    getLatestAssistantMessageForTurn: () => assistant,
    insertOrReplaceAssistantReplies: (chatId, turnId, texts, files) => {
      writes += 1;
      const now = new Date().toISOString();
      const id = assistant?.id ?? "assistant-artifact-message";
      if (!assistant) {
        harness.db.query(`
          INSERT INTO messages (
            id, chat_id, turn_id, role, text, status, created_at, updated_at,
            safe_error_code, retryable
          ) VALUES (?, ?, ?, 'assistant', ?, 'delivered', ?, ?, NULL, 0)
        `).run(id, chatId, turnId, texts.at(-1) ?? "", now, now);
      }
      messageFiles.attachToMessage(chatId, id, files ?? []);
      assistant = harness.db.query<MessageRow, [string]>(
        "SELECT rowid, * FROM messages WHERE id = ?",
      ).get(id);
      return [];
    },
  });
  const event = finalResultEvent({
    actionId: "artifact-final",
    turnId: "live-artifact-turn",
    text: "생성한 보고서입니다.",
    generatedSessionTitle: "Artifact result",
    artifacts: finalArtifacts,
  });
  writeTranscript(harness, [event]);

  expect(projection.syncNextBatch()).toBe(false);
  expect(harness.db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM message_files",
  ).get()?.count).toBe(2);
  expect(harness.db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM message_attachments",
  ).get()?.count).toBe(2);
  expect(messageFiles.refsForMessage("assistant-artifact-message")).toHaveLength(2);
  expect(writes).toBe(1);

  appendTranscript(harness, {
    ...event,
    eventId: "event-artifact-final-replay",
    payload: { ...event.payload, actionId: "artifact-final-replay" },
  });
  expect(projection.syncNextBatch()).toBe(false);
  expect(harness.db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM message_attachments",
  ).get()?.count).toBe(2);
  expect(writes).toBe(1);
  harness.close();
});

test("cancelled turn event directly closes a non-terminal App turn", () => {
  const harness = createHarness();
  seedBtccTerminalSchema(harness.db);
  seedAppTurn(harness.db, harness.chatId, "live-cancelled-turn");
  harness.db.query(`
    INSERT INTO btcc_turns (
      turn_id, semantic_state, final_disposition, delivery_outbox_id,
      canonical_assistant_message_id
    ) VALUES (?, 'cancelled', NULL, NULL, NULL)
  `).run("live-cancelled-turn");
  const state = projectionState(harness.db);
  const projection = harness.createProjectionStore(state.options);
  writeTranscript(harness, terminalTurnEvents({
    actionId: "live-cancelled-event",
    turnId: "live-cancelled-turn",
    kind: "turn.cancelled",
  }));

  expect(projection.syncNextBatch()).toBe(false);
  expect(turnState(harness.db, "live-cancelled-turn")).toBe("cancelled");
  expect(state.cancelledTurns).toEqual(["live-cancelled-turn"]);
  expect(state.assistantWrites).toBe(0);
  harness.close();
});

test("repairs the App execution model from an identityless accepted route", () => {
  const harness = createHarness();
  seedBtccTerminalSchema(harness.db);
  seedAcceptedModelRoundSchema(harness.db);
  seedAppTurn(harness.db, harness.chatId, "identityless-repair-turn");
  seedExecutionControls(harness.db, "identityless-repair-turn");
  insertAcceptedModelRound(harness.db, {
    turnId: "identityless-repair-turn",
    roundId: "identityless-round",
    candidateIndex: 0,
    modelRef: "local/gemma-local",
    transportAttempt: 1,
    providerIdentity: null,
    createdAt: "2026-08-06T00:00:00.000Z",
  });
  const state = projectionState(harness.db);
  const projection = harness.createProjectionStore(state.options);
  writeTranscript(harness, [finalResultEvent({
    actionId: "identityless-repair-event",
    turnId: "identityless-repair-turn",
    text: "Local answer",
    generatedSessionTitle: "Local title",
  })]);

  expect(projection.syncNextBatch()).toBe(false);
  expect(readExecutionModel(harness.db, "identityless-repair-turn")).toEqual({
    requested_model_ref: "openai/gpt-5.6-sol",
    adapter_effective_model_ref: "local/gemma-local",
  });
  harness.close();
});

test("chooses the latest same-timestamp backup and preserves its accepted identity", () => {
  const harness = createHarness();
  seedBtccTerminalSchema(harness.db);
  seedAcceptedModelRoundSchema(harness.db);
  seedAppTurn(harness.db, harness.chatId, "same-timestamp-repair-turn");
  seedExecutionControls(harness.db, "same-timestamp-repair-turn");
  const createdAt = "2026-08-06T00:00:00.000Z";
  insertAcceptedModelRound(harness.db, {
    turnId: "same-timestamp-repair-turn",
    roundId: "same-timestamp-round",
    candidateIndex: 0,
    modelRef: "openai/gpt-5.6-sol",
    transportAttempt: 1,
    providerIdentity: {
      provider: "openai",
      configuredModel: "openai/gpt-5.6-sol",
      reportedModel: "gpt-5.6-primary-served",
    },
    createdAt,
  });
  insertAcceptedModelRound(harness.db, {
    turnId: "same-timestamp-repair-turn",
    roundId: "same-timestamp-round",
    candidateIndex: 1,
    modelRef: "local/gemma-backup",
    transportAttempt: 1,
    providerIdentity: {
      provider: "local",
      configuredModel: "local/gemma-backup",
      reportedModel: "gemma-backup-served",
    },
    createdAt,
  });
  const state = projectionState(harness.db);
  const projection = harness.createProjectionStore(state.options);
  writeTranscript(harness, [finalResultEvent({
    actionId: "same-timestamp-repair-event",
    turnId: "same-timestamp-repair-turn",
    text: "Backup answer",
    generatedSessionTitle: "Backup title",
  })]);

  expect(projection.syncNextBatch()).toBe(false);
  expect(readExecutionModel(harness.db, "same-timestamp-repair-turn")).toEqual({
    requested_model_ref: "openai/gpt-5.6-sol",
    adapter_effective_model_ref: "local/gemma-backup",
    provider_reported_model_ref: "local/gemma-backup-served",
  });

  appendTranscript(harness, finalResultEvent({
    actionId: "same-timestamp-late-repair-event",
    turnId: "same-timestamp-repair-turn",
    text: "Backup answer",
    generatedSessionTitle: "Rejected title",
  }));
  expect(projection.syncNextBatch()).toBe(false);
  expect(readExecutionModel(harness.db, "same-timestamp-repair-turn")).toEqual({
    requested_model_ref: "openai/gpt-5.6-sol",
    adapter_effective_model_ref: "local/gemma-backup",
    provider_reported_model_ref: "local/gemma-backup-served",
  });
  harness.close();
});

function projectionState(db: Database) {
  let assistant: MessageRow | null = null;
  let assistantWrites = 0;
  const turnEvents = new Set<string>();
  const generatedTitles: string[] = [];
  const cancelledTurns: string[] = [];
  return {
    get assistant() {
      return assistant;
    },
    get assistantWrites() {
      return assistantWrites;
    },
    turnEvents,
    generatedTitles,
    cancelledTurns,
    options: {
      messageFiles: {
        createResponderFiles: () => [],
        refsForMessage: () => [],
      } as never,
      getTurnRow: (turnId: string) => appTurnRow(db, turnId),
      getTurn: (turnId: string) => ({
        id: turnId,
        state: turnState(db, turnId),
      }) as never,
      getMessageRow: (messageId: string) =>
        messageId === "user-message"
          ? ({ id: messageId, text: "Original prompt" }) as MessageRow
          : null,
      getLatestAssistantMessageForTurn: () => assistant,
      insertOrReplaceAssistantReplies: (
        chatId: string,
        turnId: string,
        texts: string[],
      ) => {
        assistantWrites += 1;
        assistant = {
          rowid: assistantWrites,
          id: "assistant-message",
          chat_id: chatId,
          turn_id: turnId,
          conversation_session_id: null,
          conversation_turn_id: null,
          conversation_message_id: null,
          role: "assistant",
          text: texts.at(-1) ?? "",
          status: "delivered",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          safe_error_code: null,
          retryable: 0,
        };
        return [];
      },
      updateTurnState: (turnId: string, state: string) => {
        db.query("UPDATE turns SET state = ? WHERE id = ?").run(state, turnId);
        return { id: turnId, state } as never;
      },
      appendTurnEvent: (
        _chatId: string,
        _turnId: string,
        event: RuntimeTurnEventInput,
      ) => {
        turnEvents.add(event.kind);
      },
      hasTurnEventKind: (_turnId: string, kind: string) =>
        turnEvents.has(kind),
      finalizeCancelledTurn: (_chatId: string, turnId: string) => {
        cancelledTurns.push(turnId);
        db.query("UPDATE turns SET state = 'cancelled' WHERE id = ?").run(turnId);
        turnEvents.add("turn.cancelled");
        return { id: turnId, state: "cancelled" } as never;
      },
      generatedSessionTitleHandler: () => (title: string) => {
        generatedTitles.push(title);
      },
    },
  };
}

function seedBtccTerminalSchema(db: Database): void {
  db.exec(`
    CREATE TABLE btcc_turns (
      turn_id TEXT PRIMARY KEY,
      semantic_state TEXT NOT NULL,
      final_disposition TEXT,
      delivery_outbox_id TEXT,
      canonical_assistant_message_id TEXT
    );
    CREATE TABLE btcc_delivery_outbox (
      outbox_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE btcc_messages (
      message_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function seedAppTurn(db: Database, chatId: string, turnId: string): void {
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO turns (
      id, chat_id, user_message_id, state, safe_status_label, retryable,
      cancellable, attempt, created_at, updated_at
    ) VALUES (?, ?, 'user-message', 'running', 'Working', 0, 1, 1, ?, ?)
  `).run(turnId, chatId, now, now);
}

function seedExecutionControls(db: Database, turnId: string): void {
  db.query(
    "UPDATE turns SET execution_controls_json = ? WHERE id = ?",
  ).run(JSON.stringify({ model_ref: "openai/gpt-5.6-sol" }), turnId);
}

function seedAcceptedModelRoundSchema(db: Database): void {
  db.exec(`
    CREATE TABLE btcc_model_round_acceptances (
      acceptance_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      route_digest TEXT NOT NULL,
      candidate_index INTEGER NOT NULL,
      checkpoint_id TEXT NOT NULL,
      checkpoint_revision INTEGER NOT NULL,
      model_ref TEXT NOT NULL,
      transport_attempt INTEGER NOT NULL,
      normalized_response_json TEXT NOT NULL,
      provider_identity_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function insertAcceptedModelRound(
  db: Database,
  input: {
    turnId: string;
    roundId: string;
    candidateIndex: number;
    modelRef: string;
    transportAttempt: number;
    providerIdentity: {
      provider: string;
      configuredModel: string;
      reportedModel: string;
    } | null;
    createdAt: string;
  },
): void {
  db.query(`
    INSERT INTO btcc_model_round_acceptances (
      acceptance_id, turn_id, round_id, route_digest, candidate_index,
      checkpoint_id, checkpoint_revision, model_ref, transport_attempt,
      normalized_response_json, provider_identity_json, created_at
    ) VALUES (?, ?, ?, 'test-route', ?, 'test-checkpoint', 1, ?, ?, '{}', ?, ?)
  `).run(
    `${input.turnId}:${input.roundId}:${input.candidateIndex}`,
    input.turnId,
    input.roundId,
    input.candidateIndex,
    input.modelRef,
    input.transportAttempt,
    input.providerIdentity ? JSON.stringify(input.providerIdentity) : null,
    input.createdAt,
  );
}

function seedCanonicalDelivery(
  db: Database,
  turnId: string,
  outboxId: string,
  messageId: string,
  content: string,
): void {
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, semantic_state, final_disposition, delivery_outbox_id,
      canonical_assistant_message_id
    ) VALUES (?, 'delivered', 'completed', ?, ?)
  `).run(turnId, outboxId, messageId);
  db.query(`
    INSERT INTO btcc_delivery_outbox (outbox_id, status)
    VALUES (?, 'observed')
  `).run(outboxId);
  db.query(`
    INSERT INTO btcc_messages (message_id, content, created_at)
    VALUES (?, ?, ?)
  `).run(messageId, content, now);
}

function terminalTurnEvents(input: {
  actionId: string;
  turnId: string;
  kind: "turn.completed" | "turn.cancelled";
}): TranscriptEvent[] {
  const outbound: TranscriptEvent = {
    eventId: `event-${input.actionId}`,
    sessionId: "runtime-session",
    kind: "outbound",
    timestamp: new Date().toISOString(),
    transport: "app",
    payload: {
      actionId: input.actionId,
      message: { text: "" },
      metadata: {
        kind: "turn_event",
        turnId: input.turnId,
        event: { kind: input.kind, payload: { safeLabel: "Terminal" } },
      },
    },
  };
  return [outbound, {
    eventId: `delivery-${input.actionId}`,
    sessionId: "runtime-session",
    kind: "delivery",
    timestamp: new Date().toISOString(),
    transport: "app",
    payload: { actionId: input.actionId, ok: true },
  }];
}

function finalResultEvent(input: {
  actionId: string;
  turnId: string;
  text: string;
  generatedSessionTitle: string;
  artifacts?: Array<Record<string, unknown>>;
}): TranscriptEvent {
  return {
    eventId: `event-${input.actionId}`,
    sessionId: "runtime-session",
    kind: "outbound",
    timestamp: new Date().toISOString(),
    transport: "app",
    payload: {
      actionId: input.actionId,
      message: {
        text: input.text,
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      },
      metadata: {
        kind: "final_result",
        turnId: input.turnId,
        generatedSessionTitle: input.generatedSessionTitle,
      },
    },
  };
}

function appTurnRow(db: Database, turnId: string): TurnRow | null {
  return db.query<TurnRow, [string]>(
    "SELECT rowid, * FROM turns WHERE id = ?",
  ).get(turnId);
}

function turnState(db: Database, turnId: string): string | null {
  return db.query<{ state: string }, [string]>(
    "SELECT state FROM turns WHERE id = ?",
  ).get(turnId)?.state ?? null;
}

function projectedReceipt(db: Database, actionId: string): boolean {
  return Boolean(db.query<{ action_id: string }, [string]>(`
    SELECT action_id FROM app_transport_projection_receipts
    WHERE action_id = ?
  `).get(actionId));
}

function readExecutionModel(db: Database, turnId: string): Record<string, string> | null {
  const row = db.query<{ execution_model_json: string | null }, [string]>(`
    SELECT execution_model_json FROM turns WHERE id = ?
  `).get(turnId);
  return row?.execution_model_json
    ? JSON.parse(row.execution_model_json) as Record<string, string>
    : null;
}
