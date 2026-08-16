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
  const legacy = new Database(paths.legacyAppDbPath);
  legacy.exec(`
    INSERT INTO btcc_inbound_inbox
      (inbox_id, session_id, trigger_key, turn_id, admission_input_hash,
        command_json, status)
    VALUES ('inbox-work-1', 'session-1', 'trigger-work-1', 'turn-work-1',
      'admission-work-1', '{}', 'claimed');
    INSERT INTO btcc_turns
      (turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, semantic_state, revision, execution_fence)
    VALUES ('turn-work-1', 'session-1', 'inbox-work-1', 'trigger-work-1',
      'message-work-1', 'complete the work', 'snapshot-work-1', '{}', '{}',
      'admitted', 1, 1);
    INSERT INTO btcc_guided_works
      (work_id, session_id, scope_kind, scope_ref, origin_turn_id,
        origin_message_id, objective, status, current_plan_revision_id,
        created_at, updated_at)
    VALUES ('work-1', 'session-1', 'session', 'session-1', 'turn-work-1',
      'message-work-1', 'complete the work', 'completed', NULL,
      '2026-08-13T00:00:00.000Z', '2026-08-13T00:01:00.000Z');
    INSERT INTO btcc_guided_work_disposition_revisions
      (disposition_revision_id, work_id, revision, result_sequence,
        material_fingerprint, disposition, summary, action_updates_json,
        remaining_actions_json, next_condition, evidence_refs_json,
        evidence_snapshot_json, followups_json, origin_turn_id, created_at)
    VALUES ('disposition-1', 'work-1', 1, 0, 'material-1', 'completed',
      'completed', '[]', '[]', NULL, '[]', '[]', '[]', 'turn-work-1',
      '2026-08-13T00:01:00.000Z');
    INSERT INTO btcc_guided_work_disposition_commands
      (mutation_call_id, request_sha256, work_id, disposition_revision_id,
        created_at)
    VALUES ('mutation-1', 'request-1', 'work-1', 'disposition-1',
      '2026-08-13T00:01:00.000Z');
    INSERT INTO btcc_guided_work_closeout_diagnostics
      (diagnostic_id, diagnostic_key, code, turn_id, work_id, created_at)
    VALUES ('diagnostic-1', 'turn-work-1:work-1', 'closeout_missing',
      'turn-work-1', 'work-1', '2026-08-13T00:01:00.000Z');
  `);
  legacy.close();
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
    expect(target.query(`
      SELECT disposition_revision_id, disposition
      FROM btcc_guided_work_disposition_revisions
    `).get()).toEqual({
      disposition_revision_id: "disposition-1",
      disposition: "completed",
    });
    expect(target.query("SELECT mutation_call_id FROM btcc_guided_work_disposition_commands").get())
      .toEqual({ mutation_call_id: "mutation-1" });
    expect(target.query("SELECT diagnostic_id FROM btcc_guided_work_closeout_diagnostics").get())
      .toEqual({ diagnostic_id: "diagnostic-1" });
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

test("source tables outside Agent ownership remain only in the legacy App database", async () => {
  const { paths, butlerData } = fixture();
  const source = new Database(paths.legacyAppDbPath);
  source.exec(`
    CREATE TABLE btcc_app_owned_state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO btcc_app_owned_state (id, value) VALUES ('app-state-1', 'preserved');
  `);
  source.close();
  const sourceBefore = sha256(paths.legacyAppDbPath);

  const result = await prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-mixed-ownership",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  });

  expect(result.kind).toBe("migrated");
  expect(sha256(paths.legacyAppDbPath)).toBe(sourceBefore);
  const legacy = new Database(paths.legacyAppDbPath, { readonly: true });
  const target = new Database(paths.agentBtccDbPath, { readonly: true });
  try {
    expect(legacy.query("SELECT value FROM btcc_app_owned_state").get())
      .toEqual({ value: "preserved" });
    expect(target.query(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'btcc_app_owned_state'
    `).get()).toBeNull();
  } finally {
    legacy.close();
    target.close();
  }
});

test("retired source columns remain only in the legacy App database", async () => {
  const { paths, butlerData } = fixture();
  const source = new Database(paths.legacyAppDbPath);
  source.exec("ALTER TABLE btcc_checkpoints ADD COLUMN app_projection_cache TEXT");
  source.close();
  const sourceBefore = sha256(paths.legacyAppDbPath);

  const result = await prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-retired-column",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  });

  expect(result.kind).toBe("migrated");
  expect(sha256(paths.legacyAppDbPath)).toBe(sourceBefore);
  const legacy = new Database(paths.legacyAppDbPath, { readonly: true });
  const target = new Database(paths.agentBtccDbPath, { readonly: true });
  try {
    expect(legacy.query(`
      SELECT name FROM pragma_table_info('btcc_checkpoints')
      WHERE name = 'app_projection_cache'
    `).get()).toEqual({ name: "app_projection_cache" });
    expect(target.query(`
      SELECT name FROM pragma_table_info('btcc_checkpoints')
      WHERE name = 'app_projection_cache'
    `).get()).toBeNull();
  } finally {
    legacy.close();
    target.close();
  }
});

test("incompatible Agent table identity fails closed before publish", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-agent-storage-incompatible-"));
  roots.push(root);
  const paths = agentBtccStoragePaths(root);
  mkdirSync(join(root, "app-server"), { recursive: true });
  const source = new Database(paths.legacyAppDbPath, { create: true });
  source.exec("CREATE TABLE btcc_messages (legacy_id TEXT PRIMARY KEY)");
  source.close();

  await expect(prepareAgentBtccStorage({
    butlerData: root,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-incompatible-identity",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  })).rejects.toThrow("agent_btcc_migration_primary_key_mismatch:btcc_messages");
  expect(Bun.file(paths.agentBtccDbPath).size).toBe(0);
});

test("inactive legacy checkpoints remain in App storage while runtime claims migrate", async () => {
  const { paths, butlerData } = fixture();
  const source = new Database(paths.legacyAppDbPath);
  source.exec("PRAGMA ignore_check_constraints = ON");
  source.exec(`
    INSERT INTO btcc_inbound_inbox (
      inbox_id, session_id, trigger_key, turn_id, admission_input_hash,
      command_json, status
    ) VALUES ('inbox-runtime', 'session-1', 'trigger-runtime',
      'runtime-turn', 'hash-runtime', '{}', 'constructed');
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, final_disposition, revision, execution_fence
    ) VALUES ('runtime-turn', 'session-1', 'inbox-runtime', 'trigger-runtime',
      'message-runtime', 'runtime request', 'snapshot', '{}', '{}',
      'delivered', 'completed', 1, 1);
    INSERT INTO btcc_checkpoints (
      checkpoint_id, turn_id, turn_revision, semantic_state, kind,
      checkpoint_revision, is_active
    ) VALUES
      ('phase-checkpoint', 'phase-turn', 1, 'execution', 'phase', 1, 0),
      ('runtime-checkpoint', 'runtime-turn', 1, 'admitted', 'runtime', 1, 0);
    INSERT INTO btcc_runtime_owners (
      owner_id, host_id, process_id, process_started_at_ms, owner_generation,
      status, registered_at
    ) VALUES ('owner-legacy', 'host', 1, 1, 1, 'closed', 'now');
    INSERT INTO btcc_state_claims (
      claim_id, turn_id, turn_revision, semantic_state, checkpoint_id,
      checkpoint_revision, execution_fence, owner_id, owner_generation,
      lease_generation, status
    ) VALUES
      ('phase-claim', 'phase-turn', 1, 'execution', 'phase-checkpoint',
        1, 1, 'owner-legacy', 1, 1, 'consumed'),
      ('runtime-claim', 'runtime-turn', 1, 'admitted', 'runtime-checkpoint',
        1, 1, 'owner-legacy', 1, 1, 'consumed');
  `);
  source.exec("PRAGMA ignore_check_constraints = OFF");
  source.close();
  const sourceBefore = sha256(paths.legacyAppDbPath);

  await prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-checkpoint-projection",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  });

  expect(sha256(paths.legacyAppDbPath)).toBe(sourceBefore);
  const target = new Database(paths.agentBtccDbPath, { readonly: true });
  try {
    expect(target.query("SELECT checkpoint_id FROM btcc_checkpoints ORDER BY checkpoint_id").all())
      .toEqual([{ checkpoint_id: "runtime-checkpoint" }]);
    expect(target.query("SELECT claim_id FROM btcc_state_claims ORDER BY claim_id").all())
      .toEqual([{ claim_id: "runtime-claim" }]);
  } finally {
    target.close();
  }
});

test("delivered legacy deferred Turns normalize to the canonical completed disposition", async () => {
  const { paths, butlerData } = fixture();
  const source = new Database(paths.legacyAppDbPath);
  source.exec("PRAGMA ignore_check_constraints = ON");
  source.exec(`
    INSERT INTO btcc_inbound_inbox (
      inbox_id, session_id, trigger_key, turn_id, admission_input_hash,
      command_json, status
    ) VALUES ('inbox-deferred', 'session-1', 'trigger-deferred',
      'turn-deferred', 'hash-deferred', '{}', 'constructed');
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, final_disposition, revision, execution_fence
    ) VALUES ('turn-deferred', 'session-1', 'inbox-deferred',
      'trigger-deferred', 'message-deferred', 'legacy request', 'snapshot',
      '{}', '{}', 'delivered', 'deferred', 1, 1);
  `);
  source.exec("PRAGMA ignore_check_constraints = OFF");
  source.close();

  await prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "legacy-fence-deferred-turn",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  });

  const target = new Database(paths.agentBtccDbPath, { readonly: true });
  try {
    expect(target.query(`
      SELECT final_disposition FROM btcc_turns WHERE turn_id = 'turn-deferred'
    `).get()).toEqual({ final_disposition: "completed" });
  } finally {
    target.close();
  }
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
