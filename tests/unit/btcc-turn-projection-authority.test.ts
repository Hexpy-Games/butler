import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  btccRetainsTurnAuthority,
  reconcileBtccTurnProjectionAuthority,
} from "../../packages/butler-agent/src/gateways/app/infrastructure/transport/btcc-turn-projection-authority.ts";
import {
  reconcileBtccTerminalDeliveries,
} from "../../packages/butler-agent/src/gateways/app/infrastructure/transport/btcc-terminal-projection.ts";
import { projectAppTurnFailure } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/projected-turn-failure.ts";

let db: Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("BTCC App projection authority", () => {
  test("repairs a false App failure while BTCC remains active", () => {
    db = fixtureDb();
    insertTurn(db, "turn-active", "planning");

    expect(btccRetainsTurnAuthority(db, "turn-active")).toBe(true);
    expect(reconcileBtccTurnProjectionAuthority(db)).toBe(1);
    expect(appTurn(db, "turn-active")).toMatchObject({
      state: "running",
      safe_error_code: null,
      cancellable: 1,
    });
    expect(assistantMessage(db, "turn-active")).toMatchObject({
      text: "",
      status: "pending",
      safe_error_code: null,
    });
  });

  test("keeps finalizing nonterminal but not cancellable", () => {
    db = fixtureDb();
    insertTurn(db, "turn-finalizing", "delivery_committed");

    expect(reconcileBtccTurnProjectionAuthority(db)).toBe(1);
    expect(appTurn(db, "turn-finalizing")).toMatchObject({
      state: "running",
      safe_status_label: "Finalizing",
      cancellable: 0,
    });
  });

  test("never reopens a canonical terminal BTCC Turn", () => {
    db = fixtureDb();
    insertTurn(db, "turn-cancelled", "cancelled");

    expect(btccRetainsTurnAuthority(db, "turn-cancelled")).toBe(false);
    expect(reconcileBtccTurnProjectionAuthority(db)).toBe(0);
    expect(appTurn(db, "turn-cancelled").state).toBe("failed");
  });

  test("rejects a queued failure as a terminal projection for an active BTCC Turn", () => {
    db = fixtureDb();
    insertTurn(db, "turn-active", "task_execution");
    let terminalUpdates = 0;

    const projected = projectAppTurnFailure({
      options: {
        db,
        getTurnRow: () => appTurn(db!, "turn-active"),
        updateTurnState: () => {
          terminalUpdates += 1;
          throw new Error("unexpected terminal update");
        },
      } as never,
      chatId: "chat-1",
      turnId: "turn-active",
      message: { text: "Butler could not complete this turn." },
      metadata: { safeErrorCode: "gateway_failed" },
      eventTimestamp: new Date().toISOString(),
    });

    expect(projected).toBe(false);
    expect(terminalUpdates).toBe(0);
  });

  test("projects a canonical BTCC delivery after the original App request owner is replaced", () => {
    db = terminalFixtureDb();
    const replies: string[] = [];
    const events: string[] = [];
    const projectedActions = new Set<string>();
    const options = {
      db,
      butlerData: "/tmp/butler-data",
      butlerHome: "/tmp/butler-home",
      messageFiles: { createResponderFiles: () => [] },
      getLatestAssistantMessageForTurn: () => null,
      getTurn: (turnId: string) => ({ id: turnId, state: appTurn(db!, turnId).state }),
      getTurnRow: (turnId: string) => appTurn(db!, turnId),
      getChatRow: () => null,
      getProjectRow: () => null,
      getMessageRow: () => null,
      hasTurnEventKind: () => false,
      insertOrReplaceAssistantReplies: (_chatId: string, _turnId: string, texts: string[]) => {
        replies.push(...texts);
        return texts.map((text) => ({ text }));
      },
      updateTurnState: (turnId: string, state: string) => {
        db!.query("UPDATE turns SET state = ? WHERE id = ?").run(state, turnId);
        return { id: turnId, state };
      },
      appendTerminalTurnStateChanged: () => events.push("state"),
      appendTurnEvent: (_chatId: string, _turnId: string, event: { kind: string }) =>
        events.push(event.kind),
      touchChat: () => undefined,
      drainQueuedSessionMessages: async () => undefined,
    } as never;
    const reconcile = () => reconcileBtccTerminalDeliveries({
      options,
      hasProjectedAction: (actionId) => projectedActions.has(actionId),
      markProjectedAction: (actionId) => { projectedActions.add(actionId); },
    });

    expect(reconcile()).toBe(1);
    expect(replies).toEqual(["canonical final"]);
    expect(appTurn(db, "turn-delivered").state).toBe("delivered");
    expect(events).toEqual([
      "message.final.started",
      "message.final.completed",
      "state",
      "turn.completed",
    ]);
    expect(reconcile()).toBe(0);
    expect(replies).toHaveLength(1);
  });
});

function fixtureDb(): Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE turns (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, state TEXT NOT NULL,
      safe_status_label TEXT NOT NULL, safe_error_code TEXT,
      retryable INTEGER NOT NULL, cancellable INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, turn_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL, safe_error_code TEXT, retryable INTEGER NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE btcc_turns (
      turn_id TEXT PRIMARY KEY, semantic_state TEXT NOT NULL
    );
  `);
  return database;
}

function insertTurn(database: Database, turnId: string, semanticState: string): void {
  database.query(`
    INSERT INTO turns VALUES (?, 'chat-1', 'failed', 'Failed', 'gateway_failed', 1, 0, 'old')
  `).run(turnId);
  database.query(`
    INSERT INTO messages VALUES (?, ?, 'assistant',
      'Butler could not complete this turn.', 'failed', 'gateway_failed', 1, 'old')
  `).run(`message-${turnId}`, turnId);
  database.query("INSERT INTO btcc_turns VALUES (?, ?)").run(turnId, semanticState);
}

function appTurn(database: Database, turnId: string) {
  return database.query<Record<string, unknown>, [string]>(`
    SELECT * FROM turns WHERE id = ?
  `).get(turnId)!;
}

function assistantMessage(database: Database, turnId: string) {
  return database.query<Record<string, unknown>, [string]>(`
    SELECT * FROM messages WHERE turn_id = ?
  `).get(turnId)!;
}

function terminalFixtureDb(): Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE turns (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE btcc_turns (
      turn_id TEXT PRIMARY KEY, semantic_state TEXT NOT NULL,
      final_disposition TEXT, delivery_outbox_id TEXT,
      canonical_assistant_message_id TEXT
    );
    CREATE TABLE btcc_delivery_outbox (
      outbox_id TEXT PRIMARY KEY, status TEXT NOT NULL
    );
    CREATE TABLE btcc_messages (
      message_id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  database.query("INSERT INTO turns VALUES ('turn-delivered', 'chat-1', 'thinking')").run();
  database.query(`
    INSERT INTO btcc_turns VALUES (
      'turn-delivered', 'delivered', 'completed', 'outbox-1', 'canonical-1'
    )
  `).run();
  database.query("INSERT INTO btcc_delivery_outbox VALUES ('outbox-1', 'observed')").run();
  database.query(`
    INSERT INTO btcc_messages VALUES ('canonical-1', 'canonical final', '2026-07-26T00:00:00Z')
  `).run();
  return database;
}
