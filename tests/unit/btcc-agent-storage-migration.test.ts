import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  activateAgentBtccStorage,
  AGENT_BTCC_STATEFUL_TABLES,
  agentBtccStoragePaths,
  prepareAgentBtccStorage,
  validateAgentBtccStorageForReadiness,
} from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/storage-ownership/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { migrateBtccSchema } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "btcc-agent-storage-"));
  roots.push(root);
  const butlerData = root;
  const paths = agentBtccStoragePaths(butlerData);
  mkdirSync(join(butlerData, "app-server"), { recursive: true });
  const source = new Database(paths.legacyAppDbPath, { create: true });
  source.exec(BTCC_SUCCESSOR_SCHEMA);
  migrateBtccSchema(source);
  source.query(`
    INSERT INTO btcc_messages
      (message_id, session_id, turn_id, role, content, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("message-1", "session-1", "turn-1", "user", "private fixture", "idem-1", "2026-08-13T00:00:00.000Z");
  source.close();
  return { root, butlerData, paths };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("legacy BTCC state migrates exactly into a create-only Agent database", async () => {
  const { paths, butlerData } = fixture();
  const before = sha256(paths.legacyAppDbPath);
  let fenced = 0;
  const result = await prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => {
      fenced += 1;
      return { fenceId: "legacy-fence-1", reconciledClaims: 2, parkedClaims: 1 };
    },
  });

  expect(result.kind).toBe("migrated");
  expect(fenced).toBe(1);
  expect(sha256(paths.legacyAppDbPath)).toBe(before);
  expect(result.receipt.tables.map((table) => table.name))
    .toEqual([...AGENT_BTCC_STATEFUL_TABLES]);
  expect(result.receipt.tables.find((table) => table.name === "btcc_messages"))
    .toMatchObject({ rowCount: 1 });

  const target = new Database(paths.agentBtccDbPath, { readonly: true });
  try {
    expect(target.query("SELECT message_id FROM btcc_messages").get())
      .toEqual({ message_id: "message-1" });
    expect(target.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  } finally {
    target.close();
  }

  const marker = activateAgentBtccStorage({ butlerData, runtimeVersion: "test-split-aware" });
  expect(marker.firstActivatedAt).toBe(marker.activatedAt);
  expect(validateAgentBtccStorageForReadiness({ butlerData }).manifestId)
    .toBe(result.receipt.manifestId);
  expect(activateAgentBtccStorage({ butlerData, runtimeVersion: "test-split-aware" }))
    .toEqual(marker);
  const evolving = new Database(paths.agentBtccDbPath);
  evolving.query(`
    INSERT INTO btcc_messages
      (message_id, session_id, turn_id, role, content, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("message-2", "session-1", "turn-2", "assistant", "new Agent state", "idem-2", "2026-08-13T00:01:00.000Z");
  evolving.close();
  expect(validateAgentBtccStorageForReadiness({ butlerData }).storageContract)
    .toBe("split-v1");
});

test("unknown legacy btcc tables fail closed without publishing a target", async () => {
  const { paths, butlerData } = fixture();
  const source = new Database(paths.legacyAppDbPath);
  source.exec("CREATE TABLE btcc_unknown_authority (id TEXT PRIMARY KEY)");
  source.close();

  await expect(prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-unknown",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  })).rejects.toThrow("agent_btcc_migration_unknown_source_table:btcc_unknown_authority");
  expect(Bun.file(paths.agentBtccDbPath).size).toBe(0);
});

test("orphaned durable Turn references fail closed before publish", async () => {
  const { paths, butlerData } = fixture();
  const source = new Database(paths.legacyAppDbPath);
  source.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, revision, execution_fence
    ) VALUES ('orphan-turn', 'session-1', 'missing-inbox', 'trigger',
      'message-1', 'request', 'record:missing', '{}', '{}', 'admitted', 1, 1)
  `).run();
  source.close();

  await expect(prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-orphan",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  })).rejects.toThrow("agent_btcc_migration_reference_check_failed:turn_inbox");
  expect(Bun.file(paths.agentBtccDbPath).size).toBe(0);
});

test("pre-admission cancellation remains valid without a Turn row", async () => {
  const { paths, butlerData } = fixture();
  const source = new Database(paths.legacyAppDbPath);
  source.query(`
    INSERT INTO btcc_stop_requests (
      stop_request_id, turn_id, status, observed_turn_revision, created_at, updated_at
    ) VALUES ('stop-1', 'not-admitted', 'cancelled_before_admission', -1, 'now', 'now')
  `).run();
  source.close();
  const result = await prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-stop", reconciledClaims: 0, parkedClaims: 0,
    }),
  });
  expect(result.kind).toBe("migrated");
});

test("already relinquished claims remain valid receipt state", async () => {
  const { paths, butlerData } = fixture();
  const source = new Database(paths.legacyAppDbPath);
  source.query(`INSERT INTO btcc_inbound_inbox
    (inbox_id, session_id, trigger_key, turn_id, admission_input_hash, command_json, status)
    VALUES ('inbox-r', 'session-r', 'trigger-r', 'turn-r', 'hash', '{}', 'pending')`).run();
  source.query(`INSERT INTO btcc_runtime_owners
    (owner_id, host_id, process_id, process_started_at_ms, owner_generation,
      status, registered_at, closed_at)
    VALUES ('owner-r', 'host-r', 1, 1, 1, 'closed', 'now', 'now')`).run();
  source.query(`INSERT INTO btcc_admission_claims
    (claim_id, inbox_id, owner_id, owner_generation, lease_generation, status)
    VALUES ('claim-r', 'inbox-r', 'owner-r', 1, 1, 'relinquished')`).run();
  source.close();
  const result = await prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-relinquished", reconciledClaims: 0, parkedClaims: 0,
    }),
  });
  expect(result.receipt.fence.parkedClaims).toBe(0);
});

test("interrupted migration removes only its temporary target and retries safely", async () => {
  const { paths, butlerData } = fixture();
  let interrupted = true;
  const input = {
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-retry",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
    faultHook(point: string) {
      if (interrupted && point === "before_publish") throw new Error("simulated interruption");
    },
  };
  await expect(prepareAgentBtccStorage(input)).rejects.toThrow("simulated interruption");
  expect(Bun.file(paths.agentBtccDbPath).size).toBe(0);
  expect(Bun.file(paths.temporaryAgentBtccDbPath).size).toBe(0);

  interrupted = false;
  const retried = await prepareAgentBtccStorage(input);
  expect(retried.kind).toBe("migrated");
  expect(Bun.file(paths.agentBtccDbPath).size).toBeGreaterThan(0);
});

test("an unreceipted final Agent target is never overwritten", async () => {
  const { paths, butlerData } = fixture();
  mkdirSync(join(butlerData, "agent-runtime"), { recursive: true });
  const target = new Database(paths.agentBtccDbPath, { create: true });
  target.exec("CREATE TABLE incomplete_target (id TEXT PRIMARY KEY)");
  target.close();
  const before = sha256(paths.agentBtccDbPath);

  await expect(prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-unreceipted",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  })).rejects.toThrow("agent_btcc_storage_unreceipted_target");
  expect(sha256(paths.agentBtccDbPath)).toBe(before);
});

test("partial migration receipts fail closed before and after activation", async () => {
  for (const activated of [false, true]) {
    const { paths, butlerData } = fixture();
    await prepareAgentBtccStorage({
      butlerData,
      quiesceLegacyWriter: async () => ({
        fenceId: `legacy-fence-partial-${activated}`,
        reconciledClaims: 0,
        parkedClaims: 0,
      }),
    });
    if (activated) {
      activateAgentBtccStorage({ butlerData, runtimeVersion: "test-split-aware" });
    }
    const db = new Database(paths.agentBtccDbPath);
    const row = db.query<{ receipt_json: string }, []>(`
      SELECT receipt_json FROM agent_storage_migration_receipt WHERE singleton = 1
    `).get()!;
    const receipt = JSON.parse(row.receipt_json) as { tables: unknown[] };
    receipt.tables = receipt.tables.slice(1);
    db.query(`
      UPDATE agent_storage_migration_receipt SET receipt_json = ? WHERE singleton = 1
    `).run(JSON.stringify(receipt));
    db.close();

    expect(() => validateAgentBtccStorageForReadiness({ butlerData }))
      .toThrow("agent_btcc_storage_receipt_invalid");
  }
});
