import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { AppTransportProjectionOwner } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/transport-projection-owner.ts";
import { AppTransportHistoricalReconciliationOwner } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/historical-reconciliation-owner.ts";
import { reconcileBtccTurnProjectionAuthorityBatch } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/btcc-turn-projection-authority.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("explicit full projection drains finite batches", async () => {
  const root = createRoot();
  let batches = 0;
  let settlementWakePasses = 0;
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => ++batches < 3,
    reopenCompletedLiveLanes: () => undefined,
    terminalSettlementWakeOwner: {
      request: () => {
        settlementWakePasses += 1;
      },
      close: () => undefined,
    },
    recordFailure: () => undefined,
  });

  owner.start();
  expect(batches).toBe(0);
  void owner.syncAndWait();
  await waitUntil(() => batches === 3);
  await Bun.sleep(50);
  expect(batches).toBe(3);
  expect(settlementWakePasses).toBe(1);
  owner.close();
});

test("one failed pass receives one cooperative recovery pass", async () => {
  const root = createRoot();
  let calls = 0;
  const failures: unknown[] = [];
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => {
      calls += 1;
      if (calls === 1) throw new Error("projection failed");
      return false;
    },
    reopenCompletedLiveLanes: () => undefined,
    terminalSettlementWakeOwner: inertSettlementWakeOwner(),
    recordFailure: (error) => {
      failures.push(error);
    },
  });

  owner.start();
  void owner.syncAndWait();
  await waitUntil(() => failures.length === 1);
  await waitUntil(() => calls === 2);
  expect((failures[0] as Error).message).toBe("projection failed");
  owner.close();
});

test("two consecutive projection failures keep the lane pending until a later success", async () => {
  const root = createRoot();
  let calls = 0;
  const failures: unknown[] = [];
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => {
      calls += 1;
      if (calls < 3) throw new RangeError("projection buffer exhausted");
      return false;
    },
    reopenCompletedLiveLanes: () => undefined,
    terminalSettlementWakeOwner: inertSettlementWakeOwner(),
    recordFailure: (error) => failures.push(error),
  });

  owner.start();
  void owner.syncAndWait();
  await waitUntil(() => calls === 3);
  expect(failures).toHaveLength(2);
  owner.close();
});

test("a locked BTCC page reaches the owner recovery path once", async () => {
  const root = createRoot();
  const dbPath = join(root, "locked.sqlite");
  const projectionDb = new Database(dbPath, { create: true });
  projectionDb.exec(`
    PRAGMA journal_mode = DELETE;
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
    INSERT INTO turns VALUES (
      'locked-turn', 'chat', 'failed', 'Failed', 'gateway_failed', 1, 0, 'old'
    );
    INSERT INTO btcc_turns VALUES ('locked-turn', 'planning');
  `);
  const lockDb = new Database(dbPath);
  lockDb.exec("BEGIN EXCLUSIVE");
  const failures: unknown[] = [];
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () =>
      reconcileBtccTurnProjectionAuthorityBatch(
        projectionDb,
        { afterRowId: 0 },
      ).pending,
    reopenCompletedLiveLanes: () => undefined,
    terminalSettlementWakeOwner: inertSettlementWakeOwner(),
    recordFailure: (error) => {
      failures.push(error);
      lockDb.exec("ROLLBACK");
    },
  });

  owner.start();
  void owner.syncAndWait();
  await waitUntil(() => failures.length === 1);
  await waitUntil(() => turnState(projectionDb, "locked-turn") === "running");
  await Bun.sleep(100);
  expect(failures).toHaveLength(1);
  owner.close();
  lockDb.close();
  projectionDb.close();
});

test("startup avoids historical transcript scans and follows changed files", async () => {
  const root = createRoot();
  let historicalScans = 0;
  let terminalPasses = 0;
  const changedFiles: string[] = [];
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => {
      historicalScans += 1;
      return false;
    },
    syncChangedTranscript: (fileName) => {
      changedFiles.push(fileName);
      return false;
    },
    syncTerminalQueue: () => {
      terminalPasses += 1;
      return false;
    },
    reopenCompletedLiveLanes: () => undefined,
    terminalSettlementWakeOwner: inertSettlementWakeOwner(),
    recordFailure: () => undefined,
  });

  owner.start();
  await waitUntil(() => terminalPasses === 1);
  expect(historicalScans).toBe(0);
  writeFileSync(join(root, "transcripts", "butler_app-live.jsonl"), "{}\n");
  await waitUntil(() => changedFiles.length === 1);
  expect(changedFiles).toEqual(["butler_app-live.jsonl"]);
  expect(historicalScans).toBe(0);
  owner.close();
});

test("startup catches up only transcripts belonging to open turns", async () => {
  const root = createRoot();
  const changedFiles: string[] = [];
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => false,
    openTurnTranscriptFiles: () => ["butler_app-open.jsonl"],
    syncChangedTranscript: (fileName) => {
      changedFiles.push(fileName);
      return false;
    },
    syncTerminalQueue: () => false,
    reopenCompletedLiveLanes: () => undefined,
    terminalSettlementWakeOwner: inertSettlementWakeOwner(),
    recordFailure: () => undefined,
  });

  owner.start();
  await waitUntil(() => changedFiles.length === 1);
  expect(changedFiles).toEqual(["butler_app-open.jsonl"]);
  owner.close();
});

test("historical maintenance contains one recovery then becomes dormant", async () => {
  let calls = 0;
  const failures: unknown[] = [];
  const maintenance = new AppTransportHistoricalReconciliationOwner({
    reconcileNextPage: () => {
      calls += 1;
      throw new Error("historical reconciliation failed");
    },
    recordFailure: (error) => failures.push(error),
  }, 10);

  maintenance.start();
  await waitUntil(() => calls === 2);
  await Bun.sleep(50);
  expect(calls).toBe(2);
  expect(failures).toHaveLength(2);
  maintenance.close();
});

test("ordinary live cycles do not restart completed historical maintenance", async () => {
  const root = createRoot();
  let historicalPages = 0;
  const maintenance = new AppTransportHistoricalReconciliationOwner({
    reconcileNextPage: () => ++historicalPages < 3,
    recordFailure: () => undefined,
  }, 10);
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => false,
    reopenCompletedLiveLanes: () => undefined,
    terminalSettlementWakeOwner: inertSettlementWakeOwner(),
    recordFailure: () => undefined,
    maintenanceOwner: maintenance,
  });

  owner.start();
  await waitUntil(() => historicalPages === 3);
  await owner.syncAndWait();
  await owner.syncAndWait();
  await Bun.sleep(50);
  expect(historicalPages).toBe(3);
  owner.close();
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "butler-transport-owner-"));
  roots.push(root);
  return root;
}

function inertSettlementWakeOwner() {
  return { request: () => undefined, close: () => undefined };
}

function turnState(db: Database, turnId: string): string | null {
  return db.query<{ state: string }, [string]>(
    "SELECT state FROM turns WHERE id = ?",
  ).get(turnId)?.state ?? null;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
