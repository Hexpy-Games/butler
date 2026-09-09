import type { Database } from "bun:sqlite";

/** Store/lifecycle fixtures need a committed wait, not an orphan approval row. */
export function bindPendingAuthorityFixture(db: Database, requestRef: string): void {
  const row = db.query<{ source_turn_id: string; source_session_id: string }, [string]>(
    "SELECT source_turn_id,source_session_id FROM btcc_authority_requests WHERE request_ref=?",
  ).get(requestRef)!;
  const callId = `call-${requestRef}`;
  db.query(`INSERT OR IGNORE INTO btcc_turns
    (turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,
     admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence)
    VALUES (?,?,?,?,?,'Fixture operation','fixture','{}','{}','admitted',0,0)`)
    .run(row.source_turn_id, row.source_session_id, `inbox-${requestRef}`, `trigger-${requestRef}`, `message-${requestRef}`);
  db.query("UPDATE btcc_authority_requests SET source_call_id=? WHERE request_ref=?").run(callId, requestRef);
  db.query(`UPDATE btcc_turns SET suspension_reason='authority_pending',authority_continuation_json=?
    WHERE turn_id=? AND semantic_state='admitted'`).run(JSON.stringify({ requestRef, callId }), row.source_turn_id);
}
