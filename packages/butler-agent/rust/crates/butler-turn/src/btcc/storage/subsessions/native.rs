//! Indexed native assignment reads. Transport metadata lives with the dispatch intent.
use super::*;
use crate::btcc::subsessions::assignment::{Child, ChildAssignment};
use butler_core::json::at;
use butler_work::store;
use rusqlite::Params;

pub(super) fn read(
    db: &rusqlite::Connection,
    predicate: &str,
    value: &str,
) -> Result<Option<Child>, StorageError> {
    let predicate = match predicate {
        "d.delegation_id=?1" => "i.op_id='child_dispatch:attempt-'||?1",
        "d.root_work_id=?1" => "t.work_id=?1",
        other => other,
    };
    db.query_row(
        &crate::btcc::storage::native_sql::assignment_read(predicate),
        [value],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
            ))
        },
    )
    .optional()
    .map_err(StorageError::sqlite)?
    .map(|(payload, attempt_id, task_id, part_id, work_id)| {
        let payload: Value = serde_json::from_str(&payload).map_err(invalid)?;
        let delegation =
            serde_json::from_value(at(&payload, "/delegation").clone()).map_err(invalid)?;
        Ok(Child::Assigned(ChildAssignment {
            delegation,
            work_id,
            task_id,
            part_id,
            attempt_id,
        }))
    })
    .transpose()
}

pub(super) fn list(
    db: &rusqlite::Connection,
    filter: &str,
    args: impl Params,
) -> Result<Vec<Child>, StorageError> {
    let mut stmt = db
        .prepare(&format!(
            "SELECT r.child_session_id FROM btcc_session_relations r {filter}"
        ))
        .map_err(StorageError::sqlite)?;
    let ids = stmt
        .query_map(args, |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StorageError::sqlite)?;
    ids.into_iter()
        .map(|id| read(db, "r.child_session_id=?1", &id))
        .filter_map(Result::transpose)
        .collect()
}

fn invalid(error: serde_json::Error) -> StorageError {
    StorageError::new(
        StorageCode::SubsessionPacketInvalid,
        "Native assignment metadata is invalid",
    )
    .with_source(error)
}

pub(super) fn result(
    db: &rusqlite::Connection,
    relation: &str,
) -> Result<Option<Value>, StorageError> {
    let Some(Child::Assigned(child)) = read(db, "r.relation_id=?1", relation)? else {
        return Ok(None);
    };
    let row = db
        .query_row(
            crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_NATIVE_INDEXED_1,
            params![child.task_id, child.child_session_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let Some((attempt, turn, state, reason, created_at, part)) = row else {
        return Ok(None);
    };
    if state == "running"
        || db
            .query_row(
                crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_NATIVE_INDEXED_2,
                [format!("result-{attempt}")],
                |_| Ok(()),
            )
            .optional()
            .map_err(StorageError::sqlite)?
            .is_none()
    {
        return Ok(None);
    }
    let content: Option<String> = db
        .query_row(
            crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_NATIVE_INDEXED_3,
            params![child.task_id, attempt],
            |r| r.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let content: Value = content
        .map(|hash| store::tool_read::body(db, &hash).map_err(super::super::work_model::work_error))
        .transpose()?
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or(Value::Null);
    let status = if part.as_deref() == Some("cancelled") {
        "cancelled"
    } else if state == "succeeded" {
        "success"
    } else if reason.as_deref() == Some("cancelled") {
        "cancelled"
    } else if state == "interrupted" && reason.is_some() {
        "blocked"
    } else {
        "failed"
    };
    let mut projected = serde_json::json!({"result_id":format!("result-{attempt}"),"child_turn_id":turn,
        "status":status,"work_status":at(&store::read_task(db, &child.task_id).map_err(super::super::work_model::work_error)?, "/status"),"summary":at(&content, "/result_refs"),"acceptance_evidence":at(&content, "/evidence_refs"),"created_at":created_at});
    project_summary(db, &content, reason, &mut projected)?;
    project_saved_delivery(db, &turn, status, &mut projected)?;
    Ok(Some(projected))
}

fn project_saved_delivery(
    db: &rusqlite::Connection,
    turn: &str,
    status: &str,
    projected: &mut Value,
) -> Result<(), StorageError> {
    let payload: Option<String> = db
        .query_row(
            crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_NATIVE_INDEXED_5,
            [&turn],
            |r| r.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .flatten();
    if let Some(payload) = payload {
        let payload: Value = serde_json::from_str(&payload).map_err(invalid)?;
        if let Some(content) = at(&payload, "/content")
            .as_str()
            .filter(|content| !content.is_empty())
        {
            butler_core::json::object_mut(projected)
                .insert("summary".into(), serde_json::json!(content));
        }
        if status == "success"
            && let Some(artifacts) = payload.get("artifacts")
        {
            butler_core::json::object_mut(projected).insert("artifacts".into(), artifacts.clone());
        }
    }
    Ok(())
}

fn project_summary(
    db: &rusqlite::Connection,
    content: &Value,
    reason: Option<String>,
    projected: &mut Value,
) -> Result<(), StorageError> {
    if let Some(reference) = at(&content, "/result_refs")
        .as_array()
        .and_then(|refs| refs.first())
        .and_then(Value::as_str)
    {
        let stored: bool = db
            .query_row(
                crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_NATIVE_INDEXED_4,
                [reference],
                |_| Ok(true),
            )
            .optional()
            .map_err(StorageError::sqlite)?
            .unwrap_or(false);
        let summary = if stored {
            serde_json::json!(
                store::tool_read::body(db, reference)
                    .map_err(super::super::work_model::work_error)?
            )
        } else {
            serde_json::json!(reference)
        };
        butler_core::json::object_mut(projected).insert("summary".into(), summary);
    } else {
        let summary = serde_json::json!(reason.unwrap_or_else(|| {
            "Delegated work could not continue: child_turn_interrupted.".into()
        }));
        butler_core::json::object_mut(projected).insert("summary".into(), summary);
    }
    Ok(())
}
