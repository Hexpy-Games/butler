import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SqliteStewardObserverStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/steward-observer-store.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";

test("work status classifies canonical state and keeps display text bounded and private", () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  seedWork(db, "running", "open", "admitted", { effect: true });
  seedWork(db, "completed", "completed", "delivered", { checkpoint: true });
  seedWork(db, "blocked", "blocked", "delivered");
  seedWork(db, "runtime", "open", "admitted", { runtimeOwnedOpen: true });
  seedWork(db, "effect", "open", "delivered", { unresolvedBlocker: true });
  seedWork(db, "recovering", "open", "admitted", { notice: "recovering" });
  seedWork(db, "interrupted", "open", "cancelled", { notice: "interrupted" });
  seedWork(db, "cleared", "blocked", "delivered", { notice: "cleared" });

  try {
    const view = new SqliteStewardObserverStore(db).workStatus();
    const state = (session: string) => view.items.find((item) =>
      item.session_id === `session-${session}`)?.state;
    expect(state("running")).toBe("running");
    expect(state("completed")).toBe("completed");
    expect(state("blocked")).toBe("attention");
    expect(state("runtime")).toBe("attention");
    expect(state("effect")).toBe("attention");
    expect(state("recovering")).toBe("operational_action");
    expect(state("interrupted")).toBe("operational_interruption");
    expect(state("cleared")).toBe("attention");
    const completed = view.items.find((item) => item.session_id === "session-completed")!;
    expect(completed.stage).toBe("validation");
    expect(completed.completed_actions).toBe(1);
    expect(completed.total_actions).toBe(2);
    expect(JSON.stringify(view)).not.toContain("/Users/private/project");
    expect(completed.safe_summary).not.toContain("work-completed");
    expect(Object.keys(view.counts)).not.toContain("failed");
    expect(view.items.find((item) => item.session_id === "session-running")?.effect_count).toBe(1);
  } finally {
    db.close();
  }
});

function seedWork(
  db: Database,
  key: string,
  status: "open" | "blocked" | "completed",
  turnState: "admitted" | "delivery_committed" | "delivered" | "cancelled",
  options: {
    checkpoint?: boolean;
    effect?: boolean;
    runtimeOwnedOpen?: boolean;
    unresolvedBlocker?: boolean;
    notice?: "recovering" | "interrupted" | "cleared";
  } = {},
): void {
  const time = `2026-09-04T00:00:${String(seedOrdinal++).padStart(2, "0")}.000Z`;
  const workId = `work-${key}`;
  const sessionId = `session-${key}`;
  const turnId = `turn-${key}`;
  db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    `relation-${key}`, "parent", "parent-turn", sessionId, `anchor-${key}`,
    seedOrdinal, `Safe ${key}`, time,
  );
  db.query(`INSERT INTO btcc_turns (
    turn_id, session_id, inbox_id, trigger_key, original_message_id,
    original_message, admission_snapshot_ref, model_selection_json,
    context_json, semantic_state, revision, execution_fence
  ) VALUES (?, ?, ?, ?, ?, '', 'snapshot', '{}', '{}', ?, 1, 1)`).run(
    turnId, sessionId, `inbox-${key}`, `trigger-${key}`, `message-${key}`, turnState,
  );
  db.query(`INSERT INTO btcc_guided_works (
    work_id, session_id, scope_kind, scope_ref, origin_turn_id,
    origin_message_id, objective, status, created_at, updated_at
  ) VALUES (?, ?, 'session', ?, ?, ?, 'private objective', ?, ?, ?)`).run(
    workId, sessionId, sessionId, turnId, `message-${key}`, status, time, time,
  );
  db.query("INSERT INTO btcc_guided_turn_work_bindings VALUES (?, ?, ?, ?, 1, 1, ?)")
    .run(`binding-${key}`, turnId, sessionId, workId, time);
  if (options.checkpoint) {
    db.query(`INSERT INTO btcc_guided_work_checkpoint_revisions VALUES (
      ?, ?, 1, 'plan', 'validation', ?, '', ?, 0, ?, ?
    )`).run(
      `checkpoint-${key}`, workId,
      `Validated ${workId} at /Users/private/project`,
      JSON.stringify([
        { actionKey: "first", status: "done" },
        { actionKey: "second", status: "active" },
      ]), turnId, time,
    );
  }
  if (status !== "open" || options.runtimeOwnedOpen) {
    db.query(`INSERT INTO btcc_guided_work_disposition_revisions (
      disposition_revision_id, work_id, revision, runtime_owned_open,
      disposition, summary, action_updates_json, remaining_actions_json,
      evidence_refs_json, evidence_snapshot_json, followups_json,
      origin_turn_id, created_at
    ) VALUES (?, ?, 1, ?, ?, 'Safe disposition', '[]', '[]', '[]', '[]', '[]', ?, ?)`)
      .run(`disposition-${key}`, workId, options.runtimeOwnedOpen ? 1 : 0, status, turnId, time);
  }
  if (options.unresolvedBlocker) {
    db.query(`INSERT INTO btcc_guided_work_effect_blockers (
      blocker_id, source_turn_id, source_occurrence_id, session_id, work_id,
      capability, target, input_json, input_sha256, idempotency_key, detail,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'edit_file', 'safe target', '{}', 'sha', ?,
      'Needs resolution', 'unresolved', ?)`)
      .run(`blocker-${key}`, turnId, `occurrence-${key}`, sessionId, workId, `idem-${key}`, time);
  }
  if (options.effect) {
    db.query(`INSERT INTO btcc_guided_effects (
      effect_id, receipt_id, idempotency_key, identity_sha256, request_sha256,
      input_sha256, target_sha256, work_id, plan_revision_id, action_key,
      capability, sanitized_target, status, journal_revision, dispatch_attempts,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'identity', 'request', 'input', 'target', ?, 'plan',
      'action', 'edit_file', 'safe target', 'prepared', 1, 0, ?, ?)`)
      .run(`effect-${key}`, `receipt-${key}`, `effect-idem-${key}`, workId, time, time);
  }
  if (options.notice) {
    db.query("INSERT INTO btcc_progress_events VALUES (?, ?, ?, ?, 1, 1, ?, ?, '{}', 'published', ?)")
      .run(
        `event-${key}`, `action-${key}`, sessionId, turnId, `fingerprint-${key}`,
        JSON.stringify({
          kind: "assistant.public_note",
          visibility: "public",
          payload: {
            bridgePhase: "operational_recovery",
            recoveryStatus: options.notice,
            note: `Operational ${options.notice}`,
          },
        }),
        time,
      );
  }
}

let seedOrdinal = 0;
