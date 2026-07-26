import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SqliteOperationalRecoveryStore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/operational-recovery-store.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { migrateBtccSchema } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts";
import { OperationalInterruptionError } from
  "../../packages/butler-agent/src/agent/btcc/index.ts";

test("runtime remediation retains its private diagnostic cause", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(db);
    const store = new SqliteOperationalRecoveryStore(db);
    const anchor = {
      turnId: "turn-diagnostic",
      turnRevision: 3,
      semanticState: "contract_review",
      checkpointId: "checkpoint-diagnostic",
      checkpointRevision: 5,
      claimId: "claim-diagnostic",
      executionFence: 0,
    };
    await store.record(new OperationalInterruptionError(
      "runtime_unclassified_interruption",
      anchor,
      { kind: "runtime_remediation" },
      new Error("inactive Spec entered the current catalog"),
    ));

    const row = db.query<{ diagnostic_message: string }, []>(`
      SELECT diagnostic_message FROM btcc_operational_interruptions
    `).get();
    expect(row?.diagnostic_message)
      .toBe("inactive Spec entered the current catalog");
    const restored = await store.pending(anchor);
    expect(restored?.interruption.cause).toEqual(
      new Error("inactive Spec entered the current catalog"),
    );
  } finally {
    db.close();
  }
});

test("startup closes an interruption whose state claim already committed", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(db);
    db.query(`
      INSERT INTO btcc_state_claims (
        claim_id, turn_id, turn_revision, semantic_state,
        checkpoint_id, checkpoint_revision, execution_fence,
        owner_id, owner_generation, lease_generation, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'consumed')
    `).run("claim-completed", "turn-completed", 4, "task_execution",
      "checkpoint-completed", 3, 0, "owner", 1, 1);
    db.query(`
      INSERT INTO btcc_operational_interruptions (
        interruption_id, turn_id, turn_revision, semantic_state,
        checkpoint_id, checkpoint_revision, claim_id, execution_fence,
        code, activation_kind, activation_count, status, interrupted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ready', ?)
    `).run("interruption-completed", "turn-completed", 4, "task_execution",
      "checkpoint-completed", 3, "claim-completed", 0,
      "provider_protocol_interruption", "automatic_provider_recovery",
      new Date().toISOString());

    new SqliteOperationalRecoveryStore(db);

    expect(db.query<{ status: string }, []>(`
      SELECT status FROM btcc_operational_interruptions
    `).get()?.status).toBe("resolved");
  } finally {
    db.close();
  }
});

test("process restart activates only inherited runtime remediation", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(db);
    seedActiveInterruption(db, "runtime", "runtime_remediation");
    seedActiveInterruption(db, "provider", "provider_action_required");
    const store = new SqliteOperationalRecoveryStore(db);

    await store.activateInheritedRuntimeRemediations();

    const rows = db.query<{ activation_kind: string; status: string }, []>(`
      SELECT activation_kind, status FROM btcc_operational_interruptions
      ORDER BY activation_kind
    `).all();
    expect(rows).toEqual([
      { activation_kind: "provider_action_required", status: "interrupted" },
      { activation_kind: "runtime_remediation", status: "ready" },
    ]);
  } finally {
    db.close();
  }
});

function seedActiveInterruption(
  db: Database,
  suffix: string,
  activationKind: string,
): void {
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, continuation_snapshot_json, semantic_state,
      active_checkpoint_id, revision, execution_fence
    ) VALUES (?, ?, ?, ?, ?, '', '{}', '{}', '{}', '[]',
      'task_execution', ?, 1, 0)
  `).run(
    `turn-${suffix}`,
    `session-${suffix}`,
    `inbox-${suffix}`,
    `trigger-${suffix}`,
    `message-${suffix}`,
    `checkpoint-${suffix}`,
  );
  db.query(`
    INSERT INTO btcc_state_claims (
      claim_id, turn_id, turn_revision, semantic_state,
      checkpoint_id, checkpoint_revision, execution_fence,
      owner_id, owner_generation, lease_generation, status
    ) VALUES (?, ?, 1, 'task_execution', ?, 1, 0, 'owner', 1, 1, 'active')
  `).run(`claim-${suffix}`, `turn-${suffix}`, `checkpoint-${suffix}`);
  db.query(`
    INSERT INTO btcc_operational_interruptions (
      interruption_id, turn_id, turn_revision, semantic_state,
      checkpoint_id, checkpoint_revision, claim_id, execution_fence,
      code, activation_kind, activation_count, status, interrupted_at
    ) VALUES (?, ?, 1, 'task_execution', ?, 1, ?, 0,
      'simulated', ?, 1, 'interrupted', ?)
  `).run(
    `interruption-${suffix}`,
    `turn-${suffix}`,
    `checkpoint-${suffix}`,
    `claim-${suffix}`,
    activationKind,
    new Date().toISOString(),
  );
}
