import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTCC_TERMINAL_SETTLEMENT_WAKE_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/terminal-settlement-wake-schema.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteStopController } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-stop-controller.ts";
import { ManagedTurnProjectionWriter } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/managed-turn-projection-writer.ts";
import { TerminalSettlementWakeStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/retention/terminal-settlement-wake-store.ts";
import { TerminalSettlementWakeOwner } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/retention/terminal-settlement-wake-owner.ts";
import { AppTransportProjectionOwner } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/transport-projection-owner.ts";

test("terminal transitions enqueue delivered and cancelled wakes idempotently", () => {
  const db = fixtureDb();
  db.exec(`
    INSERT INTO btcc_turns VALUES ('delivered-turn', 'execution');
    INSERT INTO btcc_turns VALUES ('cancelled-turn', 'cancelled');
    UPDATE btcc_turns SET semantic_state = 'delivered'
    WHERE turn_id = 'delivered-turn';
    UPDATE btcc_turns SET semantic_state = 'delivered'
    WHERE turn_id = 'delivered-turn';
  `);

  expect(wakeRows(db)).toEqual([
    { turn_id: "cancelled-turn", semantic_state: "cancelled" },
    { turn_id: "delivered-turn", semantic_state: "delivered" },
  ]);
  db.close();
});

test("wake consumption is bounded to 32 exact turn ids", () => {
  const db = fixtureDb();
  insertWakes(db, 40);
  const store = new TerminalSettlementWakeStore(db);
  const scheduled: string[] = [];

  expect(store.consumeNextBatch((turnId) => scheduled.push(turnId))).toEqual({
    consumed: 32,
    pending: true,
  });
  expect(scheduled).toHaveLength(32);
  expect(wakeCount(db)).toBe(8);
  expect(store.consumeNextBatch((turnId) => scheduled.push(turnId))).toEqual({
    consumed: 8,
    pending: false,
  });
  expect(new Set(scheduled).size).toBe(40);
  expect(wakeCount(db)).toBe(0);
  db.close();
});

test("unacknowledged wakes survive consumer restart", () => {
  const db = fixtureDb();
  insertWakes(db, 40);
  const owned = new Set<string>();
  let interrupted = false;
  const firstStore = new TerminalSettlementWakeStore(db);

  expect(() => firstStore.consumeNextBatch((turnId) => {
    if (turnId === "wake-02" && !interrupted) {
      interrupted = true;
      throw new Error("process interrupted");
    }
    owned.add(turnId);
  })).toThrow("process interrupted");
  expect(owned).toEqual(new Set(["wake-01"]));
  expect(wakeCount(db)).toBe(39);

  const restartedStore = new TerminalSettlementWakeStore(db);
  let result;
  do {
    result = restartedStore.consumeNextBatch((turnId) => owned.add(turnId));
  } while (result.pending);
  expect(owned.size).toBe(40);
  expect(wakeCount(db)).toBe(0);
  db.close();
});

test("one live cycle drains a 100-wake burst in bounded ticks", async () => {
  const db = fixtureDb();
  const root = mkdtempSync(join(tmpdir(), "butler-settlement-burst-"));
  insertWakes(db, 100);
  const store = new TerminalSettlementWakeStore(db);
  const scheduled = new Set<string>();
  const batchSizes: number[] = [];
  const owner = new TerminalSettlementWakeOwner({
    consumeNextBatch: () => {
      const result = store.consumeNextBatch((turnId) => scheduled.add(turnId));
      batchSizes.push(result.consumed);
      return result;
    },
    recordFailure: (error) => {
      throw error;
    },
  }, 1);
  const live = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => false,
    reopenCompletedLiveLanes: () => undefined,
    terminalSettlementWakeOwner: owner,
    recordFailure: (error) => {
      throw error;
    },
  });

  live.start();
  await live.syncAndWait();
  await waitUntil(() => wakeCount(db) === 0);
  expect(scheduled.size).toBe(100);
  expect(batchSizes).toEqual([32, 32, 32, 4]);
  expect(Math.max(...batchSizes)).toBe(32);
  live.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("close preserves durable wakes for a restarted owner", async () => {
  const db = fixtureDb();
  insertWakes(db, 40);
  const store = new TerminalSettlementWakeStore(db);
  const closedOwner = new TerminalSettlementWakeOwner({
    consumeNextBatch: () => store.consumeNextBatch(() => undefined),
    recordFailure: () => undefined,
  }, 50);
  closedOwner.request();
  closedOwner.close();
  await Bun.sleep(60);
  expect(wakeCount(db)).toBe(40);

  const restartedOwner = new TerminalSettlementWakeOwner({
    consumeNextBatch: () => store.consumeNextBatch(() => undefined),
    recordFailure: (error) => {
      throw error;
    },
  }, 1);
  restartedOwner.request();
  await waitUntil(() => wakeCount(db) === 0);
  restartedOwner.close();
  db.close();
});

test("settlement wake owner contains one failed-tick recovery", async () => {
  let calls = 0;
  const failures: unknown[] = [];
  const owner = new TerminalSettlementWakeOwner({
    consumeNextBatch: () => {
      calls += 1;
      if (calls <= 2) throw new Error("wake drain failed");
      return { consumed: 0, pending: false };
    },
    recordFailure: (error) => failures.push(error),
  }, 1);

  owner.request();
  await waitUntil(() => calls === 2);
  await Bun.sleep(20);
  expect(calls).toBe(2);
  expect(failures).toHaveLength(2);
  owner.close();
});

test("Stop and managed cancellation CAS enqueue exact wakes", () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  insertFullTurn(db, "stopped-turn", "execution");
  insertFullTurn(db, "managed-cancel-turn", "conception_opening");

  expect(new SqliteStopController(db).stop("stopped-turn")).toEqual({
    kind: "cancelled",
    turnId: "stopped-turn",
  });
  new ManagedTurnProjectionWriter(db).cancelWork({
    turnId: "managed-cancel-turn",
    revision: 0,
  } as never, 1, {} as never);

  expect(wakeRows(db)).toEqual([
    { turn_id: "managed-cancel-turn", semantic_state: "cancelled" },
    { turn_id: "stopped-turn", semantic_state: "cancelled" },
  ]);
  db.close();
});

function fixtureDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE btcc_turns (
      turn_id TEXT PRIMARY KEY,
      semantic_state TEXT NOT NULL
    );
    ${BTCC_TERMINAL_SETTLEMENT_WAKE_SCHEMA}
  `);
  return db;
}

function insertWakes(db: Database, count: number): void {
  const insert = db.query(`
    INSERT INTO btcc_terminal_settlement_wakes (
      turn_id, semantic_state, settled_at
    ) VALUES (?, 'delivered', 'now')
  `);
  for (let index = 1; index <= count; index += 1) {
    insert.run(`wake-${index.toString().padStart(2, "0")}`);
  }
}

function insertFullTurn(
  db: Database,
  turnId: string,
  semanticState: string,
): void {
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, continuation_snapshot_json, semantic_state,
      revision, execution_fence
    ) VALUES (?, 'session', ?, ?, ?, 'request', 'snapshot', '{}', '{}', '[]',
      ?, 0, 0)
  `).run(
    turnId,
    `inbox-${turnId}`,
    `trigger-${turnId}`,
    `message-${turnId}`,
    semanticState,
  );
}

function wakeRows(db: Database) {
  return db.query<{
    turn_id: string;
    semantic_state: string;
  }, []>(`
    SELECT turn_id, semantic_state FROM btcc_terminal_settlement_wakes
    ORDER BY turn_id
  `).all();
}

function wakeCount(db: Database): number {
  return db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM btcc_terminal_settlement_wakes
  `).get()?.count ?? 0;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
