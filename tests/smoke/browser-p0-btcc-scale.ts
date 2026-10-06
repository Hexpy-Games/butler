import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { statSync } from "node:fs";
import { join } from "node:path";

/** Same terminal-history shape as butler-e2e/tests/e2e/support/btcc_scale.rs. */
export function seedP0BtccScale(data: string) {
  const path = join(data, "agent-runtime/btcc.sqlite"), db = new Database(path);
  const body = "x".repeat(23000);
  db.exec("PRAGMA busy_timeout=10000; BEGIN");
  const inbox = db.prepare("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?1,'p0-history',?1,?1,'fixture','{}','constructed')");
  const relation = db.prepare("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at,activity_role,activity_worker_id,activity_terminal) VALUES(?1,'p0-history',?1,?1,?1,?2,'Historical child','2026-01-01T00:00:00Z','steward',?1,1)");
  const turn = db.prepare("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?1,'p0-history',?1,?1,?1,?2,'fixture','{}','{}','delivered',1,1)");
  const outbox = db.prepare("INSERT INTO btcc_subsession_outbox(outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at) VALUES(?1,?1,?1,'p0-history',?1,?1,'{}','delivered','2026-01-01T00:00:00Z')");
  for (let i = 0; i < 300000; i++) {
    const id = `p0-history-${String(i).padStart(6, "0")}`;
    inbox.run(id); relation.run(id, i); turn.run(id, body); outbox.run(id);
  }
  db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  for (const [table, key] of [["btcc_turns", "turn_id"], ["btcc_session_relations", "relation_id"], ["btcc_inbound_inbox", "inbox_id"], ["btcc_subsession_outbox", "outbox_id"]]) {
    const row = db.query(`SELECT COUNT(*) n FROM ${table} WHERE ${key} LIKE 'p0-history-%'`).get() as { n: number };
    assert.equal(row.n, 300000);
  }
  for (const id of ["p0-history-000000", "p0-history-299999"]) {
    const row = db.query("SELECT original_message FROM btcc_turns WHERE turn_id=?").get(id) as { original_message: string };
    assert.equal(row.original_message, body);
  }
  db.close(); const bytes = statSync(path).size; assert(bytes >= 7_000_000_000);
  return { bytes, terminalTurns: 300000 };
}
