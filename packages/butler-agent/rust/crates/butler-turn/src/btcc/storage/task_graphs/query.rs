//! Indexed Work-scoped queries, in the storage lane's single read snapshot.
use super::{ChildRecord, GraphRecords, GraphScope, ReviewRecord, WorkRecord};
use crate::btcc::{decode_task_graph_id as decode_id, storage::StorageError};
use rusqlite::{Connection, OptionalExtension, Row};
use serde_json::Value;

const TREE: &str = "WITH RECURSIVE sessions(id) AS (SELECT ?1 UNION SELECT r.child_session_id FROM btcc_session_relations r JOIN sessions s ON r.parent_session_id=s.id), selected(id) AS (SELECT work_id FROM btcc_guided_works WHERE session_id IN (SELECT id FROM sessions) UNION SELECT work_id FROM btcc_guided_turn_work_bindings WHERE is_current=1 AND session_id IN (SELECT id FROM sessions)) ";
// Unary + removes column affinity so SQLite can use the JSON expression index.
// Work identities in both the table and packet are strings.
const WORK_SELECT: &str = "SELECT w.work_id,w.session_id,p.objective,p.actions_json,p.checks_json,p.governing_refs_json,COALESCE(c.action_states_json,'[]'),w.updated_at,w.status,p.execution_mode,COALESCE(c.stage,'planning'),c.created_at,c.next_step,json_extract(own.packet_json,'$.objective'),EXISTS(SELECT 1 FROM btcc_subsession_delegations d JOIN btcc_guided_works child ON child.work_id=d.root_work_id WHERE json_extract(d.packet_json,'$.parent_work_ref.work_id')=+w.work_id AND json_extract(d.packet_json,'$.child_role')='steward' AND child.current_plan_revision_id IS NOT NULL),p.plan_revision_id||COALESCE(c.checkpoint_revision_id,'') FROM selected s JOIN btcc_guided_works w ON w.work_id=s.id JOIN btcc_guided_work_plan_revisions p ON p.plan_revision_id=w.current_plan_revision_id LEFT JOIN btcc_guided_work_checkpoint_revisions c ON c.work_id=w.work_id AND c.revision=(SELECT MAX(revision) FROM btcc_guided_work_checkpoint_revisions WHERE work_id=w.work_id) LEFT JOIN btcc_session_relations incoming ON incoming.child_session_id=w.session_id LEFT JOIN btcc_subsession_delegations own ON own.relation_id=incoming.relation_id WHERE COALESCE(json_extract(own.packet_json,'$.child_role'),'')!='worker' ORDER BY w.created_at,w.work_id";
const CHILD_SELECT: &str = "SELECT d.task_id,r.parent_session_id,r.parent_turn_id,r.child_session_id,COALESCE(t.turn_id,d.child_turn_id),r.ordinal,r.safe_title,d.packet_json,CASE WHEN t.turn_id IS NULL OR x.child_turn_id=t.turn_id THEN x.status END,CASE WHEN t.turn_id IS NULL OR x.child_turn_id=t.turn_id THEN x.created_at END,t.semantic_state,r.created_at,c.next_step,c.stage,CASE WHEN t.turn_id IS NULL OR x.child_turn_id=t.turn_id THEN x.summary END FROM selected s JOIN btcc_subsession_delegations d ON json_extract(d.packet_json,'$.parent_work_ref.work_id')=+s.id JOIN btcc_session_relations r ON r.relation_id=d.relation_id LEFT JOIN btcc_steward_results x ON x.result_id=(SELECT result_id FROM btcc_steward_results WHERE relation_id=r.relation_id ORDER BY created_at DESC,result_id DESC LIMIT 1) LEFT JOIN btcc_turns t ON t.rowid=(SELECT rowid FROM btcc_turns WHERE session_id=r.child_session_id ORDER BY rowid DESC LIMIT 1) LEFT JOIN btcc_guided_work_checkpoint_revisions c ON c.work_id=d.root_work_id AND c.revision=(SELECT MAX(revision) FROM btcc_guided_work_checkpoint_revisions WHERE work_id=d.root_work_id) ORDER BY r.created_at,r.ordinal,d.task_id";
const REVIEW_SELECT: &str = "SELECT r.work_id,r.subject,r.verdict,r.summary,r.created_at,r.review_revision_id FROM selected s JOIN btcc_guided_work_review_revisions r ON r.work_id=s.id AND r.revision=(SELECT MAX(revision) FROM btcc_guided_work_review_revisions WHERE work_id=s.id)";

pub(super) fn read(db: &Connection, scope: GraphScope) -> Result<GraphRecords, StorageError> {
    let (prefix, id) = match resolve_task(db, scope)? {
        GraphScope::Session(id) => (TREE.to_owned(), id),
        GraphScope::Plan(id) => (
            "WITH selected(id) AS (SELECT ?1) ".into(),
            decode_id(&id, "work:").map_or(id, |(id, _)| id),
        ),
        GraphScope::Task(_) => return Err(StorageError::sqlite(rusqlite::Error::InvalidQuery)),
    };
    let works = select(db, &prefix, WORK_SELECT, &id, work_row)?;
    let children = select(db, &prefix, CHILD_SELECT, &id, child_row)?;
    let reviews = select(db, &prefix, REVIEW_SELECT, &id, |r| {
        Ok(ReviewRecord {
            id: r.get(5)?,
            work_id: r.get(0)?,
            subject: r.get(1)?,
            verdict: r.get(2)?,
            summary: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    Ok(GraphRecords {
        works,
        children,
        reviews,
    })
}

fn select<T>(
    db: &Connection,
    prefix: &str,
    sql: &str,
    id: &str,
    row: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, StorageError> {
    db.prepare_cached(&format!("{prefix}{sql}"))
        .map_err(StorageError::sqlite)?
        .query_map([id], row)
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)
}

fn work_row(r: &Row<'_>) -> rusqlite::Result<WorkRecord> {
    Ok(WorkRecord {
        id: r.get(0)?,
        session_id: r.get(1)?,
        objective: r.get(2)?,
        actions: decode(&r.get::<_, String>(3)?)?,
        checks: decode(&r.get::<_, String>(4)?)?,
        refs: decode(&r.get::<_, String>(5)?)?,
        progress: decode(&r.get::<_, String>(6)?)?,
        updated_at: r.get(7)?,
        status: r.get(8)?,
        execution_mode: r.get(9)?,
        phase: r.get(10)?,
        checkpoint_at: r.get(11)?,
        next_step: r.get(12)?,
        delegated_objective: r.get(13)?,
        has_planned_steward: r.get(14)?,
        source_revision: r.get(15)?,
    })
}
fn child_row(r: &Row<'_>) -> rusqlite::Result<ChildRecord> {
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
        result_summary: r.get(14)?,
    })
}
fn resolve_task(db: &Connection, scope: GraphScope) -> Result<GraphScope, StorageError> {
    let GraphScope::Task(id) = scope else {
        return Ok(scope);
    };
    if let Some((work, _)) = decode_id(&id, "task:") {
        return Ok(GraphScope::Plan(work));
    }
    let work = db.query_row("SELECT json_extract(packet_json,'$.parent_work_ref.work_id') FROM btcc_subsession_delegations WHERE task_id=?1",[id],|r| r.get::<_,Option<String>>(0))
        .optional().map_err(StorageError::sqlite)?.flatten().unwrap_or_default();
    Ok(GraphScope::Plan(work))
}
fn decode(raw: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}
