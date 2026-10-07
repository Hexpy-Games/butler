//! Owner-scale history with real indexed BTCC rows, never owner data.
use super::*;
use rusqlite::{Connection, params};
use std::path::Path;

pub(super) fn seed(data: &Path) -> Result<u64, HarnessError> {
    let path = data.join("agent-runtime/btcc.sqlite");
    let mut db = Connection::open(&path)?;
    let tx = db.transaction()?;
    {
        let mut inbox=tx.prepare("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?1,'history',?1,?1,'fixture','{}','constructed')")?;
        let mut turn=tx.prepare("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?1,'history',?1,?1,?1,?2,'fixture','{}','{}','delivered',1,1)")?;
        let body = "x".repeat(26_000);
        for i in 0..100_000 {
            let id = format!("history-{i:06}");
            inbox.execute([&id])?;
            turn.execute(params![id, body])?;
        }
        let mut relation=tx.prepare("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES(?1,'history',?1,?1,?1,?2,'History','2026-01-01')")?;
        let mut delegation=tx.prepare("INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,created_at) VALUES(?1,?1,?1,?1,?1,?2,'2026-01-01')")?;
        let mut result=tx.prepare("INSERT INTO btcc_steward_results(result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES(?1,?1,?1,?1,?1,'success','History','[]','[]','2026-01-01')")?;
        for i in 0..10_000 {
            let id = format!("history-relation-{i:06}");
            relation.execute(params![id, i])?;
            let packet = json!({"child_role":"worker","delegation_id":id,"task_id":id,"parent_session_id":"history","parent_turn_id":id,"relation_id":id,"access_mode":"read_only","execution_mode":"read_only","objective":"History","acceptance_criteria":[],"task_or_plan_refs":[],"constraints_and_non_goals":[],"allowed_tools_and_effects":[],"mutation_scope":[],"model_ref":"openai/gpt-6-luna","reasoning_effort":"max"});
            delegation.execute(params![id, packet.to_string()])?;
            result.execute([id])?;
        }
    }
    tx.commit()?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    let bytes = std::fs::metadata(path)?.len();
    assert!(bytes >= 2_600_000_000, "fixture too small: {bytes}");
    Ok(bytes)
}
pub(super) fn assert_indexes(data: &Path) -> Result<(), HarnessError> {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    for (query, index) in [
        (
            "SELECT * FROM btcc_subsession_delegations WHERE json_extract(packet_json,'$.parent_work_ref.plan_revision_id')='graph-6-0'",
            "idx_btcc_graph_plan",
        ),
        (
            "SELECT * FROM btcc_session_relations WHERE parent_session_id='parent' AND parent_turn_id='turn' ORDER BY ordinal",
            "idx_btcc_graph_parent_turn",
        ),
        (
            "SELECT * FROM btcc_steward_results WHERE relation_id='relation' ORDER BY created_at DESC LIMIT 1",
            "idx_btcc_graph_result",
        ),
        (
            "SELECT * FROM agent_task_graph_changes WHERE seq>42 ORDER BY seq",
            "INTEGER PRIMARY KEY",
        ),
        (
            "SELECT * FROM btcc_guided_work_checkpoint_revisions WHERE work_id='source' AND plan_revision_id='plan' ORDER BY revision DESC LIMIT 1",
            "idx_btcc_graph_checkpoint_plan",
        ),
    ] {
        let plan = db
            .prepare(&format!("EXPLAIN QUERY PLAN {query}"))?
            .query_map([], |r| r.get::<_, String>(3))?
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        assert!(plan.contains(index), "{query}: {plan}");
        assert!(
            !plan.contains("SCAN btcc_") && !plan.contains("SCAN agent_task_graph_changes"),
            "{plan}"
        );
    }
    let turns: i64 = db.query_row(
        "SELECT COUNT(*) FROM btcc_turns WHERE session_id='history'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(turns, 100_000);
    let relations: i64 = db.query_row(
        "SELECT COUNT(*) FROM btcc_session_relations WHERE parent_session_id='history'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(relations, 10_000);
    Ok(())
}
