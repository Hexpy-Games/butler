import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateAppStoreSchema } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import { AppEventStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/events/event-store.ts";
import { eventTurnMatchSql } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/events/event-turn-query.ts";
import { AppTurnProgressEventStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/events/turn-progress-event-store.ts";
import { terminalTurnPage } from
  "../../packages/butler-agent/src/gateways/app/application/kernel/app-terminal-retention-initializer.ts";

test("existing projects receive one stable collision-safe Ledger binding", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_label TEXT NOT NULL,
      safe_path_label TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES (
      'project-sandy', 'Sandy', 'active', '/workspace/sandy', 'sandy-bot',
      'sandy-bot', 0, 0, NULL, '2026-01-01', '2026-01-01'
    );
    INSERT INTO projects VALUES (
      'project-a', 'Shared A', 'active', '/workspace/a', 'shared-web',
      'shared-web', 0, 0, NULL, '2026-01-02', '2026-01-02'
    );
    INSERT INTO projects VALUES (
      'project-b', 'Shared B', 'active', '/workspace/b', 'shared-web',
      'shared-web', 0, 0, NULL, '2026-01-03', '2026-01-03'
    );
    INSERT INTO projects VALUES (
      'project-unsafe', 'Unsafe', 'active', '/workspace/unsafe', 'Unsafe Name',
      'Unsafe Name', 0, 0, NULL, '2026-01-04', '2026-01-04'
    );
    INSERT INTO projects VALUES (
      'project-case-a', 'Case A', 'active', '/workspace/case-a', 'Foo',
      'Foo', 0, 0, NULL, '2026-01-05', '2026-01-05'
    );
    INSERT INTO projects VALUES (
      'project-case-b', 'Case B', 'active', '/workspace/case-b', 'foo',
      'foo', 0, 0, NULL, '2026-01-06', '2026-01-06'
    );
    INSERT INTO projects VALUES (
      'project-c', 'ID collision', 'active', '/workspace/c', 'project-d',
      'project-d', 0, 0, NULL, '2026-01-07', '2026-01-07'
    );
    INSERT INTO projects VALUES (
      'project-d', 'ID owner', 'active', '/workspace/d', 'project-d',
      'project-d', 0, 0, NULL, '2026-01-08', '2026-01-08'
    );
  `);

  migrateAppStoreSchema(db);

  const bindings = db.query<{ id: string; ledger_project_id: string }, []>(`
    SELECT id, ledger_project_id FROM projects ORDER BY id
  `).all();
  expect(bindings).toEqual([
    { id: "project-a", ledger_project_id: "project-a" },
    { id: "project-b", ledger_project_id: "project-b" },
    { id: "project-c", ledger_project_id: "project-c" },
    { id: "project-case-a", ledger_project_id: "project-case-a" },
    { id: "project-case-b", ledger_project_id: "project-case-b" },
    { id: "project-d", ledger_project_id: "project-d" },
    { id: "project-sandy", ledger_project_id: "sandy-bot" },
    { id: "project-unsafe", ledger_project_id: "project-unsafe" },
  ]);
  migrateAppStoreSchema(db);
  expect(db.query<{ ledger_project_id: string }, [string]>(`
    SELECT ledger_project_id FROM projects WHERE id = ?
  `).get("project-sandy")?.ledger_project_id).toBe("sandy-bot");
  db.close();
});

test("existing event stores retain JSON indexes without backfill or replacement", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  migrateAppStoreSchema(db);
  db.exec(`
    CREATE INDEX events_type_turn_id_idx
    ON events(type, json_extract(payload_json, '$.turn_id'), id DESC);
    CREATE INDEX events_turn_event_kind_idx
    ON events(
      type,
      json_extract(payload_json, '$.turn_id'),
      json_extract(payload_json, '$.event.kind'),
      id DESC
    );
  `);
  const insert = db.query(`
    INSERT INTO events (type, turn_id, payload_json, created_at)
    VALUES ('agent.turn_event', NULL, ?, '2026-07-27T00:00:00.000Z')
  `);
  for (let index = 0; index < 150; index += 1) {
    insert.run(JSON.stringify({
      turn_id: `legacy-${index}`,
      event: { kind: "turn.completed" },
    }));
  }
  insert.run(JSON.stringify({
    message: { turn_id: "legacy-nested" },
    event: { kind: "turn.completed" },
  }));

  migrateAppStoreSchema(db);

  expect(nullTurnIdCount(db)).toBe(151);
  expect(indexExists(db, "events_type_turn_id_idx")).toBe(true);
  expect(indexExists(db, "events_turn_event_kind_idx")).toBe(true);
  expect(indexExists(db, "events_turn_id_idx")).toBe(false);
  expect(new AppEventStore(db).hasTurnEventKind(
    "legacy-149",
    "turn.completed",
  )).toBe(true);
  expect(db.query<{ id: number }, [string]>(`
    SELECT id FROM events
    WHERE ${eventTurnMatchSql(db, { legacyPayload: "all" })}
  `).get("legacy-nested")).not.toBeNull();
  db.close();
});

test("new event stores index extracted nested turn and message identifiers", () => {
  const db = new Database(":memory:");
  migrateAppStoreSchema(db);
  const events = new AppEventStore(db);
  events.append("agent.turn_event", {
    turn: { id: "turn-nested" },
    event: { kind: "turn.completed" },
  });
  events.append("message.updated", {
    message: { id: "message-1", turn_id: "turn-message" },
  });

  expect(indexExists(db, "events_turn_id_idx")).toBe(true);
  expect(events.hasTurnEventKind("turn-nested", "turn.completed")).toBe(true);
  expect(db.query<{ turn_id: string }, []>(`
    SELECT turn_id FROM events WHERE type = 'message.updated'
  `).get()?.turn_id).toBe("turn-message");
  db.close();
});

test("only a new store receives the terminal sweep index", () => {
  const db = new Database(":memory:");
  migrateAppStoreSchema(db);
  expect(indexExists(db, "turns_state_rowid_idx")).toBe(true);

  db.exec("DROP INDEX turns_state_rowid_idx");
  migrateAppStoreSchema(db);
  expect(indexExists(db, "turns_state_rowid_idx")).toBe(false);
  db.close();
});

test("progress equivalence uses exact finite row identity candidates", () => {
  const db = new Database(":memory:");
  migrateAppStoreSchema(db);
  const events = new AppEventStore(db);
  const progress = progressStore(db, events);
  const target = {
    id: "target-row",
    kind: "tool",
    safe_label: "Inspect target",
    state: "delivered",
    created_at: "2026-07-27T00:00:00.000Z",
  };
  progress.appendProgressSummaryEvent("chat-1", "turn-1", target);
  for (let index = 0; index < 512; index += 1) {
    progress.appendProgressSummaryEvent("chat-1", "turn-1", {
      ...target, id: `other-${index}`,
    });
  }

  expect(progress.hasEquivalentProgressSummaryRow("turn-1", target)).toBe(true);
  expect(progress.hasEquivalentProgressSummaryRow("turn-1", {
    ...target,
    safe_label: "Different target",
  })).toBe(false);
  db.close();
});

test("an old store adds bounded progress identities without indexing history", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  migrateAppStoreSchema(db);
  const events = new AppEventStore(db);
  const progress = progressStore(db, events);
  const row = progress.appendProgressSummaryEvent("chat-1", "turn-1", {
    id: "new-row", kind: "tool", state: "delivered", safe_label: "New row",
  });

  expect(progress.hasEquivalentProgressSummaryRow("turn-1", row)).toBe(true);
  expect(indexExists(db, "events_progress_row_identity_idx")).toBe(false);
  expect(db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM app_progress_row_identities
  `).get()?.count).toBe(1);
  db.close();
});

test("old-store terminal discovery advances through raw nonterminal pages", () => {
  const db = new Database(":memory:");
  migrateAppStoreSchema(db);
  db.exec("DROP INDEX turns_state_rowid_idx");
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO chats (id, title, kind, created_at, updated_at)
    VALUES ('chat-1', 'Legacy', 'chat', ?, ?)
  `).run(now, now);
  const insert = db.query(`
    INSERT INTO turns (
      id, chat_id, state, safe_status_label, retryable, cancellable,
      attempt, created_at, updated_at
    ) VALUES (?, 'chat-1', ?, 'State', 0, 0, 1, ?, ?)
  `);
  for (let index = 1; index <= 70; index += 1) {
    insert.run(`turn-${index}`, index === 65 ? "delivered" : "running", now, now);
  }

  const first = terminalTurnPage(db, 0, 32);
  const second = terminalTurnPage(db, first.nextCursor, 32);
  const third = terminalTurnPage(db, second.nextCursor, 32);
  expect(first.turns).toEqual([]);
  expect(second.turns).toEqual([]);
  expect(third.turns.map((turn) => turn.turnId)).toEqual(["turn-65"]);
  expect([first.nextCursor, second.nextCursor, third.nextCursor])
    .toEqual([32, 64, 70]);
  db.close();
});

function progressStore(db: Database, events: AppEventStore) {
  return new AppTurnProgressEventStore({
    db,
    appendEvent: (type, payload) => events.append(type, payload),
    nextSessionTurnEventSequence: () => 1,
    nextTurnEventSequence: () => 1,
    shouldPersistRuntimeTurnEvent: () => true,
    isTerminalTurn: () => false,
    getTurnRow: () => null,
    terminalProjectionForTurn: () => null,
  });
}

function nullTurnIdCount(db: Database): number {
  return db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM events WHERE turn_id IS NULL
  `).get()?.count ?? 0;
}

function indexExists(db: Database, name: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?
  `).get(name));
}
