//! SQL selects are scoped by indexed session, plan or task identities.
use super::{ChildRecord, GraphRecords, GraphScope, PlanRecord};
use crate::btcc::storage::StorageError;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

const TREE: &str = "WITH RECURSIVE sessions(id) AS (SELECT ?1 UNION SELECT r.child_session_id FROM btcc_session_relations r JOIN sessions s ON r.parent_session_id=s.id) ";
const PLAN_SELECT: &str = "SELECT p.plan_revision_id,p.objective,p.actions_json,p.checks_json,p.governing_refs_json,COALESCE(c.action_states_json,'[]'),MAX(w.updated_at,COALESCE(c.created_at,w.updated_at)),w.status FROM btcc_guided_work_plan_revisions p JOIN btcc_guided_works w ON w.work_id=p.work_id LEFT JOIN btcc_guided_work_checkpoint_revisions c ON c.checkpoint_revision_id=(SELECT checkpoint_revision_id FROM btcc_guided_work_checkpoint_revisions WHERE work_id=w.work_id AND plan_revision_id=p.plan_revision_id ORDER BY revision DESC LIMIT 1) ";
const CHILD_SELECT: &str = "SELECT d.task_id,r.parent_session_id,r.parent_turn_id,r.child_session_id,COALESCE(t.turn_id,d.child_turn_id),r.ordinal,r.safe_title,d.packet_json,CASE WHEN t.turn_id IS NULL OR x.child_turn_id=t.turn_id THEN x.status END,CASE WHEN t.turn_id IS NULL OR x.child_turn_id=t.turn_id THEN x.created_at END,t.semantic_state,r.created_at,c.next_step,c.stage FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id LEFT JOIN btcc_steward_results x ON x.result_id=(SELECT result_id FROM btcc_steward_results WHERE relation_id=r.relation_id ORDER BY created_at DESC,result_id DESC LIMIT 1) LEFT JOIN btcc_turns t ON t.rowid=(SELECT rowid FROM btcc_turns WHERE session_id=r.child_session_id ORDER BY rowid DESC LIMIT 1) LEFT JOIN btcc_guided_work_checkpoint_revisions c ON c.checkpoint_revision_id=(SELECT checkpoint_revision_id FROM btcc_guided_work_checkpoint_revisions WHERE work_id=d.root_work_id ORDER BY revision DESC LIMIT 1) ";

pub(super) fn read(db: &Connection, scope: GraphScope) -> Result<GraphRecords, StorageError> {
    let scope = resolve_task(db, scope)?;
    let (prefix, id, plans, children) = match scope {
        GraphScope::Session(id) => (TREE.to_owned(),id,
            "WHERE p.plan_revision_id IN (SELECT current_plan_revision_id FROM btcc_guided_works WHERE session_id IN (SELECT id FROM sessions) UNION SELECT w.current_plan_revision_id FROM btcc_guided_turn_work_bindings b JOIN btcc_guided_works w ON w.work_id=b.work_id WHERE b.is_current=1 AND b.session_id IN (SELECT id FROM sessions) UNION SELECT json_extract(d.packet_json,'$.parent_work_ref.plan_revision_id') FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id WHERE r.parent_session_id IN (SELECT id FROM sessions)) AND NOT EXISTS(SELECT 1 FROM btcc_subsession_delegations d JOIN btcc_session_relations r ON r.relation_id=d.relation_id WHERE r.child_session_id=w.session_id AND json_extract(d.packet_json,'$.child_role')='worker')".to_owned(),
            "WHERE r.parent_session_id IN (SELECT id FROM sessions)".to_owned()),
        GraphScope::Plan(id) if id.starts_with("group:") => {
            let (session,turn) = super::super::super::task_graph_identity::decode(&id, "group:").unwrap_or_default();
            (String::new(),serde_json::json!([session,turn]).to_string(),"WHERE p.plan_revision_id=?1".into(),
                "WHERE r.parent_session_id=json_extract(?1,'$[0]') AND r.parent_turn_id=json_extract(?1,'$[1]') AND json_extract(d.packet_json,'$.parent_work_ref.plan_revision_id') IS NULL".into())
        },
        GraphScope::Plan(id) => (String::new(),id,"WHERE p.plan_revision_id=?1".into(),"WHERE json_extract(d.packet_json,'$.parent_work_ref.plan_revision_id')=?1".into()),
        GraphScope::Task(_) => return Err(StorageError::sqlite(rusqlite::Error::InvalidQuery)),
    };
    let plans = db
        .prepare_cached(&format!(
            "{prefix}{PLAN_SELECT}{plans} ORDER BY p.created_at,p.plan_revision_id"
        ))
        .map_err(StorageError::sqlite)?
        .query_map([&id], |r| {
            Ok(PlanRecord {
                id: r.get(0)?,
                objective: r.get(1)?,
                actions: decode(&r.get::<_, String>(2)?)?,
                checks: decode(&r.get::<_, String>(3)?)?,
                refs: decode(&r.get::<_, String>(4)?)?,
                progress: decode(&r.get::<_, String>(5)?)?,
                updated_at: r.get(6)?,
                status: r.get(7)?,
            })
        })
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    let children = db
        .prepare_cached(&format!(
            "{prefix}{CHILD_SELECT}{children} ORDER BY r.ordinal"
        ))
        .map_err(StorageError::sqlite)?
        .query_map([&id], |r| {
            Ok(ChildRecord {
                task_id: r.get(0)?,
                parent_session: r.get(1)?,
                parent_turn: r.get(2)?,
                session_id: r.get(3)?,
                turn_id: r.get(4)?,
                ordinal: r.get(5)?,
                title: r.get(6)?,
                packet: decode(&r.get::<_, String>(7)?)?,
                result_status: r.get(8)?,
                result_at: r.get(9)?,
                turn_state: r.get(10)?,
                created_at: r.get(11)?,
                current_step: r.get(12)?,
                stage: r.get(13)?,
            })
        })
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    Ok(GraphRecords { plans, children })
}

fn resolve_task(db: &Connection, scope: GraphScope) -> Result<GraphScope, StorageError> {
    let GraphScope::Task(id) = scope else {
        return Ok(scope);
    };
    if let Some((plan, _)) = super::super::super::task_graph_identity::decode(&id, "task:") {
        return Ok(GraphScope::Plan(plan));
    }
    let target = db.query_row("SELECT json_extract(d.packet_json,'$.parent_work_ref.plan_revision_id'),r.parent_session_id,r.parent_turn_id FROM btcc_subsession_delegations d JOIN btcc_session_relations r ON r.relation_id=d.relation_id WHERE d.task_id=?1",[id],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional().map_err(StorageError::sqlite)?;
    Ok(GraphScope::Plan(target.map_or_else(
        String::new,
        |(plan, session, turn)| {
            plan.unwrap_or_else(|| {
                super::super::super::task_graph_identity::encode("group:", &session, &turn)
            })
        },
    )))
}

fn decode(raw: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}
