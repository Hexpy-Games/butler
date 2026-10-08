//! Settled authority history for the owner-scale idle fixture.
use rusqlite::Connection;

pub(crate) fn history(db: &Connection, payload_bytes: usize) {
    // 10k unrelated settled requests: large payloads must never enter the list query.
    db.execute(&format!("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<9999)
      INSERT INTO btcc_authority_requests(request_id,request_ref,identity_sha256,owner_session_id,source_session_id,source_turn_id,source_work_id,workspace_path,plan_revision_id,action_key,authority_generation,capability,normalized_target,normalized_input_json,model_ref,reasoning_effort,category,reason,executable,command_count,decision,allow_scope,schedule_client_message_id,schedule_input_text,outcome,created_at,updated_at)
      SELECT 'history-'||i,'history-'||i,'history-'||i,'unrelated','unrelated','history-'||i,'history-'||i,'/history','history','history-'||i,1,'run_command','history',json_object('padding',printf('%0{payload_bytes}d',i)),'custom/stub','low','command','history','run_command',1,'modified','once','history-'||i,'','applied','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z' FROM n"), []).unwrap();
    let mut plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM btcc_authority_requests WHERE owner_session_id='butler/app-chat-0' AND decision='allowed' AND allow_scope='conversation' ORDER BY created_at").unwrap();
    let details = plan
        .query_map([], |row| row.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        details
            .iter()
            .any(|s| s.contains("idx_btcc_authority_requests_owner_pending"))
    );
    assert!(
        details
            .iter()
            .all(|s| !s.contains("SCAN btcc_authority_requests"))
    );
}
