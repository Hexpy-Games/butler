import type { Database } from "bun:sqlite";
import {
  CONVERSATION_STORE_SCHEMA_SQL,
  CONVERSATION_STORE_POST_MIGRATION_SQL,
  CONVERSATION_STORE_SCHEMA_VERSION,
} from "./schema.ts";

const BTCC_PHASE_STATE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["lifecycle_status", "TEXT NOT NULL DEFAULT 'active'"],
  ["current_phase", "TEXT NOT NULL DEFAULT 'conception'"],
  ["phase_generation", "INTEGER NOT NULL DEFAULT 1"],
  ["row_version", "INTEGER NOT NULL DEFAULT 1"],
  ["project_policy_json", "TEXT NOT NULL DEFAULT '{\"kind\":\"unbound\"}'"],
  ["tracking_policy_candidate_json", "TEXT"],
  ["tracking_policy_json", "TEXT"],
  ["accepted_controls_ref", "TEXT NOT NULL DEFAULT ''"],
  ["goal_contract_ref", "TEXT"],
  ["active_conception_checkpoint_ref", "TEXT"],
  ["active_planning_checkpoint_ref", "TEXT"],
  ["active_execution_checkpoint_ref", "TEXT"],
  ["active_review_checkpoint_ref", "TEXT"],
  ["active_consolidation_checkpoint_ref", "TEXT"],
  ["active_reporting_checkpoint_ref", "TEXT"],
  ["active_consolidation_target_ref", "TEXT"],
  ["active_final_dossier_ref", "TEXT"],
  ["active_tracking_attempt_ref", "TEXT"],
  ["active_execution_operation_ref", "TEXT"],
  ["active_review_target_ref", "TEXT"],
  ["open_tool_call_ref", "TEXT"],
  ["plan_revision_ref", "TEXT"],
  ["active_tracking_work_ref", "TEXT"],
  ["active_task_ref", "TEXT"],
  ["active_return_ticket_ref", "TEXT"],
  ["pending_closeout_ref", "TEXT"],
  ["active_continuation_owner_ref", "TEXT"],
  ["accepted_receipt_refs_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["invalidated_receipt_refs_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["last_stable_input_fingerprint", "TEXT NOT NULL DEFAULT ''"],
];

export function ensureConversationStoreSchema(db: Database): void {
  db.exec(CONVERSATION_STORE_SCHEMA_SQL);
  const migrate = db.transaction(() => {
    const columns = new Set(
      db.query<{ name: string }, []>("PRAGMA table_info(btcc_turn_states)")
        .all()
        .map((row) => row.name),
    );
    const addedLifecycleStatus = !columns.has("lifecycle_status");
    for (const [name, definition] of BTCC_PHASE_STATE_COLUMNS) {
      if (!columns.has(name)) {
        db.exec(`ALTER TABLE btcc_turn_states ADD COLUMN ${name} ${definition}`);
      }
    }
    if (addedLifecycleStatus) {
      db.exec(`
        UPDATE btcc_turn_states
        SET lifecycle_status = CASE state
          WHEN 'waiting_user' THEN 'waiting_user'
          WHEN 'waiting_external' THEN 'waiting_external'
          WHEN 'waiting_runtime' THEN 'waiting_runtime'
          WHEN 'cancelled' THEN 'cancelled'
          WHEN 'delivered' THEN 'delivered'
          ELSE 'active'
        END,
        accepted_controls_ref = CASE
          WHEN accepted_controls_ref = '' THEN 'controls:' || turn_id
          ELSE accepted_controls_ref
        END
      `);
    }
    db.query(`
      INSERT OR IGNORE INTO conversation_schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(CONVERSATION_STORE_SCHEMA_VERSION, new Date().toISOString());
  });
  migrate();
  db.exec(CONVERSATION_STORE_POST_MIGRATION_SQL);
}
