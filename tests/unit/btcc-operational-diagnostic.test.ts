import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SqliteOperationalRecoveryStore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/operational-recovery-store.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { migrateBtccSchema } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts";
import { OperationalInterruptionError } from
  "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";
import type { OperationalDiagnostic } from
  "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";

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

test("provider readiness deadline survives interruption persistence", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(db);
    const store = new SqliteOperationalRecoveryStore(db);
    const anchor = {
      turnId: "turn-rate-limit",
      turnRevision: 1,
      semanticState: "conception_opening",
      checkpointId: "checkpoint-rate-limit",
      checkpointRevision: 1,
      claimId: "claim-rate-limit",
      executionFence: 0,
    };
    const retryAt = "2026-07-27T06:00:00.000Z";
    const diagnostic = {
      schema: "btcc.operational-diagnostic.v1" as const,
      kind: "provider_request" as const,
      provider: "zai",
      api: "chat_completions",
      statusCode: 429,
      retryable: true,
      retryAt,
      providerRequestId: "zai-request-429",
      rateLimit: { retryAfter: "8", remaining: "0" },
    };
    await store.record(new OperationalInterruptionError(
      "provider_rate_limited",
      anchor,
      { kind: "automatic_provider_recovery", retryAt },
      undefined,
      diagnostic,
    ));
    const persisted = db.query<{ retry_at: string; diagnostic_json: string }, []>(`
      SELECT retry_at, diagnostic_json FROM btcc_operational_interruptions
    `).get();
    expect(persisted?.retry_at).toBe(retryAt);
    expect(JSON.parse(persisted?.diagnostic_json ?? "null")).toEqual(diagnostic);
    const restored = (await store.pending(anchor))?.interruption;
    expect(restored?.activation).toEqual({
      kind: "automatic_provider_recovery",
      retryAt,
    });
    expect(restored?.diagnostic).toEqual(diagnostic);
  } finally {
    db.close();
  }
});

test("optional diagnostic corruption never blocks pending checkpoint recovery", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(db);
    const store = new SqliteOperationalRecoveryStore(db);
    const anchor = {
      turnId: "turn-corrupt-diagnostic",
      turnRevision: 1,
      semanticState: "task_execution",
      checkpointId: "checkpoint-corrupt-diagnostic",
      checkpointRevision: 2,
      claimId: "claim-corrupt-diagnostic",
      executionFence: 0,
    };
    await store.record(new OperationalInterruptionError(
      "provider_rate_limited",
      anchor,
      { kind: "provider_action_required" },
    ));
    const corruptValues = [
      "{malformed",
      "null",
      JSON.stringify({
        schema: "btcc.operational-diagnostic.v999",
        kind: "provider_request",
      }),
    ];
    for (const diagnosticJson of corruptValues) {
      db.query(`
        UPDATE btcc_operational_interruptions SET diagnostic_json = ?
      `).run(diagnosticJson);
      const pending = await store.pending(anchor);
      expect(pending?.status).toBe("interrupted");
      expect(pending?.interruption.activation).toEqual({
        kind: "provider_action_required",
      });
      expect(pending?.interruption.diagnostic).toBeUndefined();
    }
  } finally {
    db.close();
  }
});

test("durable provider diagnostics retain only normalized safe metadata", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(db);
    const store = new SqliteOperationalRecoveryStore(db);
    const anchor = {
      turnId: "turn-safe-diagnostic",
      turnRevision: 1,
      semanticState: "conception",
      checkpointId: "checkpoint-safe-diagnostic",
      checkpointRevision: 1,
      claimId: "claim-safe-diagnostic",
      executionFence: 0,
    };
    const providerControlled = {
      schema: "btcc.operational-diagnostic.v1",
      kind: "provider_request",
      provider: "zai",
      api: "chat_completions",
      statusCode: 429,
      endpoint: "https://api.example.test/v1/chat?prompt=secret#payload",
      model: "glm-5.2",
      retryable: true,
      detail: "prompt and filesystem path",
      cause: "authorization=secret",
      retryAt: "2099-10-21T07:28:00Z",
      providerRequestId: "request-429",
      requestGeneration: 4,
      measuredInputTokens: 1200,
      registeredInputCapacity: 64000,
      requestHash: "a".repeat(64),
      rateLimit: {
        retryAfter: "secret payload",
        reset: "Wed, 21 Oct 2099 07:28:00 GMT",
        limit: "100",
        remaining: "-1",
        providerPayload: "unknown secret",
      },
      providerPayload: { prompt: "secret" },
    } as unknown as OperationalDiagnostic;
    await store.record(new OperationalInterruptionError(
      "provider_rate_limited",
      anchor,
      { kind: "automatic_provider_recovery", retryAt: "2099-10-21T07:28:00.000Z" },
      new Error("provider echoed prompt=secret"),
      providerControlled,
    ));

    type PersistedDiagnostic = {
      diagnostic_message: string | null; diagnostic_json: string;
    };
    const persisted = db.query<PersistedDiagnostic, []>(`
      SELECT diagnostic_message, diagnostic_json
      FROM btcc_operational_interruptions
    `).get();
    expect(persisted?.diagnostic_message).toBeNull();
    expect(JSON.parse(persisted?.diagnostic_json ?? "null")).toEqual({
      schema: "btcc.operational-diagnostic.v1",
      kind: "provider_request",
      provider: "zai",
      api: "chat_completions",
      retryable: true,
      statusCode: 429,
      endpoint: "https://api.example.test/v1/chat",
      model: "glm-5.2",
      retryAt: "2099-10-21T07:28:00.000Z",
      providerRequestId: "request-429",
      requestGeneration: 4,
      measuredInputTokens: 1200,
      registeredInputCapacity: 64000,
      requestHash: "a".repeat(64),
      rateLimit: {
        reset: "2099-10-21T07:28:00.000Z",
        limit: "100",
      },
    });
  } finally {
    db.close();
  }
});

test("legacy 429 without provider readiness is parked instead of replayed", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(db);
    seedActiveInterruption(db, "legacy-429", "automatic_provider_recovery", {
      code: "provider_rate_limited",
    });

    new SqliteOperationalRecoveryStore(db);

    expect(db.query<{ activation_kind: string; retry_at: string | null }, []>(`
      SELECT activation_kind, retry_at FROM btcc_operational_interruptions
    `).get()).toEqual({
      activation_kind: "provider_action_required",
      retry_at: null,
    });
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
  options: { code?: string } = {},
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
      ?, ?, 1, 'interrupted', ?)
  `).run(
    `interruption-${suffix}`,
    `turn-${suffix}`,
    `checkpoint-${suffix}`,
    `claim-${suffix}`,
    options.code ?? "simulated",
    activationKind,
    new Date().toISOString(),
  );
}
