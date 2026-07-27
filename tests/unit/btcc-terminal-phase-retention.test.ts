import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  BtccTerminalPhaseRetentionQueue,
  SqliteBtccTerminalPhaseRetention,
} from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";

test("settled cleanup advances beyond an ineligible App-turn prefix", () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  db.exec("CREATE TABLE turns (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
  const retention = new SqliteBtccTerminalPhaseRetention(
    db,
    (turnId) => db.query<{ state: string }, [string]>(
      "SELECT state FROM turns WHERE id = ?",
    ).get(turnId)?.state ?? null,
    () => true,
  );
  const limit = 2;
  for (let index = 0; index < limit * 5 + 1; index += 1) {
    const turnId = `turn-running-${index}`;
    db.query("INSERT INTO turns (id, state) VALUES (?, 'running')").run(turnId);
    insertSettledRevision(db, turnId);
  }
  insertSettledRevision(db, "turn-eligible");

  expect(retention.compactSettledBatch(limit)).toBe(true);
  expect(revisionCount(db, "turn-eligible")).toBe(1);
  expect(retention.compactSettledBatch(limit)).toBe(true);
  expect(revisionCount(db, "turn-eligible")).toBe(0);
  expect(revisionCount(db, "turn-running-0")).toBe(1);
  expect(retention.compactSettledBatch(limit)).toBe(false);
  db.close();
});

test("global BTCC cleanup yields between bounded batches", async () => {
  let batches = 0;
  const queue = new BtccTerminalPhaseRetentionQueue({
    compactBatch: () => {
      batches += 1;
      return batches < 2;
    },
    recordFailure: (error) => {
      throw error;
    },
  });

  queue.schedule();
  await Bun.sleep(100);
  expect(batches).toBe(0);
  await waitUntil(() => batches === 1);
  await Bun.sleep(100);
  expect(batches).toBe(1);
  await waitUntil(() => batches === 2);
  queue.close();
});

test("global BTCC cleanup makes one delayed recovery attempt", async () => {
  let batches = 0;
  const failures: unknown[] = [];
  const queue = new BtccTerminalPhaseRetentionQueue({
    compactBatch: () => {
      batches += 1;
      if (batches === 1) throw new Error("busy");
      return false;
    },
    recordFailure: (error) => failures.push(error),
  });

  queue.schedule();
  await waitUntil(() => batches === 1);
  expect(failures).toHaveLength(1);
  await Bun.sleep(100);
  expect(batches).toBe(1);
  await waitUntil(() => batches === 2);
  await Bun.sleep(300);
  expect(batches).toBe(2);
  queue.close();
});

test("default BTCC maintenance compacts one eligible turn per tick", () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  db.exec("CREATE TABLE turns (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
  for (const turnId of ["eligible-1", "eligible-2", "eligible-3"]) {
    insertSettledRevision(db, turnId);
  }
  const retention = new SqliteBtccTerminalPhaseRetention(
    db,
    () => null,
    () => true,
  );

  expect(retention.compactSettledBatch()).toBe(true);
  expect(totalRevisionCount(db)).toBe(2);
  expect(retention.compactSettledBatch()).toBe(true);
  expect(totalRevisionCount(db)).toBe(1);
  db.close();
});

test("one terminal cleanup deletes at most eight revisions", () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  db.exec("CREATE TABLE turns (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
  insertSettledRevision(db, "turn-bounded");
  for (let revision = 2; revision <= 20; revision += 1) {
    db.query(`
      INSERT INTO btcc_phase_checkpoint_revisions (
        checkpoint_id, checkpoint_revision, previous_revision_ref,
        state_claim_id, execution_fence, status
      ) VALUES ('checkpoint-turn-bounded', ?, ?, ?, 1, 'accepted_boundary')
    `).run(revision, `revision-${revision - 1}`, `claim-${revision}`);
  }
  const retention = new SqliteBtccTerminalPhaseRetention(
    db,
    () => "delivered",
    () => true,
  );

  expect(retention.compactTurn("turn-bounded")).toBe(true);
  expect(revisionCount(db, "turn-bounded")).toBe(12);
  db.close();
});

function insertSettledRevision(db: Database, turnId: string): void {
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, continuation_snapshot_json, semantic_state,
      revision, execution_fence, final_disposition
    ) VALUES (?, ?, ?, ?, ?, 'request', 'admission', '{}', '{}', '[]',
      'delivered', 1, 1, 'completed')
  `).run(turnId, turnId, `inbox-${turnId}`, `trigger-${turnId}`, `message-${turnId}`);
  db.query(`
    INSERT INTO btcc_checkpoints (
      checkpoint_id, turn_id, turn_revision, semantic_state, kind,
      checkpoint_revision, accepted_product_json, actual_identity_json, is_active
    ) VALUES (?, ?, 1, 'reporting', 'phase', 1, '{}', '{}', 0)
  `).run(`checkpoint-${turnId}`, turnId);
  db.query(`
    INSERT INTO btcc_phase_checkpoint_revisions (
      checkpoint_id, checkpoint_revision, previous_revision_ref,
      state_claim_id, execution_fence, status
    ) VALUES (?, 1, 'revision-0', ?, 1, 'accepted_boundary')
  `).run(`checkpoint-${turnId}`, `claim-${turnId}`);
}

function revisionCount(db: Database, turnId: string): number {
  return db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count
    FROM btcc_phase_checkpoint_revisions AS revision
    JOIN btcc_checkpoints AS checkpoint
      ON checkpoint.checkpoint_id = revision.checkpoint_id
    WHERE checkpoint.turn_id = ?
  `).get(turnId)?.count ?? 0;
}

function totalRevisionCount(db: Database): number {
  return db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM btcc_phase_checkpoint_revisions
  `).get()?.count ?? 0;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
