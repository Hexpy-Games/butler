use crate::btcc::StorageCode;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

use crate::btcc::work::{WorkStatus, WorkTurnScope};

use super::{StorageError, StorageResult};

#[derive(Clone)]
pub(super) struct WorkRow {
    pub id: String,
    pub session_id: String,
    pub scope_kind: String,
    pub scope_ref: String,
    pub origin_turn_id: String,
    pub origin_message_id: String,
    pub objective: String,
    pub status: String,
    pub current_plan_revision_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl WorkRow {
    pub(super) fn is_open(&self) -> bool {
        self.status == "open" || self.status == "blocked"
    }
    pub(super) fn status(&self) -> StorageResult<WorkStatus> {
        parse_enum(&self.status)
    }
}

#[derive(Clone)]
pub(super) struct TurnRow {
    pub id: String,
    pub session_id: String,
    pub message_id: String,
    pub state: String,
    pub fence: u64,
}

pub(super) fn session_scope(scope: &WorkTurnScope) -> StorageResult<()> {
    if scope.project_ref.is_some() {
        return Err(error(
            StorageCode::ProjectWorkRepositoryRequired,
            "Project Work requires its canonical Project Ledger repository",
        ));
    }
    Ok(())
}

pub(super) fn error(code: StorageCode, message: impl Into<String>) -> StorageError {
    StorageError::new(code, message)
}

pub(super) fn parse_enum<T: serde::de::DeserializeOwned>(value: &str) -> StorageResult<T> {
    serde_json::from_value(Value::String(value.into())).map_err(|err| {
        error(StorageCode::DurableWorkHydrationFailed, err.to_string()).with_source(err)
    })
}

pub(super) fn parse_json<T: serde::de::DeserializeOwned>(value: &str) -> StorageResult<T> {
    serde_json::from_str(value).map_err(|err| {
        error(StorageCode::DurableWorkHydrationFailed, err.to_string()).with_source(err)
    })
}

pub(super) fn enum_text<T: Serialize>(value: T) -> StorageResult<String> {
    serde_json::to_value(value)
        .map_err(|err| {
            error(StorageCode::DurableWorkSerializationFailed, err.to_string()).with_source(err)
        })?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| {
            error(
                StorageCode::DurableWorkSerializationFailed,
                "enum did not encode as text",
            )
        })
}

pub(super) fn stable<T: Serialize>(value: &T) -> StorageResult<String> {
    let value = serde_json::to_value(value).map_err(|err| {
        error(StorageCode::DurableWorkSerializationFailed, err.to_string()).with_source(err)
    })?;
    crate::btcc::identity::sqlite_stable_json(&value)
        .map_err(|err| error(StorageCode::DurableWorkSerializationFailed, err.message()))
}

pub(super) fn record_id(kind: &str, identity: &str) -> String {
    format!(
        "guided-{kind}-{}",
        crate::btcc::identity::digest(&format!("btcc-guided-work.v1\0{kind}\0{identity}"))
    )
}

fn work_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkRow> {
    Ok(WorkRow {
        id: row.get("work_id")?,
        session_id: row.get("session_id")?,
        scope_kind: row.get("scope_kind")?,
        scope_ref: row.get("scope_ref")?,
        origin_turn_id: row.get("origin_turn_id")?,
        origin_message_id: row.get("origin_message_id")?,
        objective: row.get("objective")?,
        status: row.get("status")?,
        current_plan_revision_id: row.get("current_plan_revision_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(super) fn work(db: &Connection, id: &str) -> StorageResult<Option<WorkRow>> {
    db.query_row(
        "SELECT * FROM btcc_guided_works WHERE work_id = ?1",
        [id],
        work_row,
    )
    .optional()
    .map_err(StorageError::sqlite)
}

pub(super) fn bound(db: &Connection, turn_id: &str) -> StorageResult<Option<WorkRow>> {
    db.query_row("SELECT work.* FROM btcc_guided_turn_work_bindings binding JOIN btcc_guided_works work ON work.work_id = binding.work_id WHERE binding.turn_id = ?1 AND binding.is_current = 1", [turn_id], work_row)
        .optional().map_err(StorageError::sqlite)
}

pub(super) fn head(db: &Connection, session_id: &str) -> StorageResult<Option<WorkRow>> {
    db.query_row("SELECT work.* FROM btcc_guided_work_session_heads head JOIN btcc_guided_works work ON work.work_id = head.work_id WHERE head.session_id = ?1", [session_id], work_row)
        .optional().map_err(StorageError::sqlite)
}

pub(super) fn turn(db: &Connection, scope: &WorkTurnScope) -> StorageResult<TurnRow> {
    let row = db.query_row("SELECT turn_id, session_id, original_message_id, semantic_state, execution_fence FROM btcc_turns WHERE turn_id = ?1", [&scope.turn_id], |row| {
        Ok(TurnRow { id: row.get(0)?, session_id: row.get(1)?, message_id: row.get(2)?, state: row.get(3)?, fence: row.get(4)? })
    }).optional().map_err(StorageError::sqlite)?;
    let row = row.ok_or_else(|| {
        error(
            StorageCode::DurableWorkTurnNotAdmitted,
            format!("Durable Work Turn is not admitted: {}", scope.turn_id),
        )
    })?;
    if row.session_id != scope.session_id {
        return Err(error(
            StorageCode::DurableWorkTurnSessionMismatch,
            format!(
                "Durable Work Turn Session does not match: {}",
                scope.turn_id
            ),
        ));
    }
    Ok(row)
}

pub(super) fn relation_turn(db: &Connection, scope: &WorkTurnScope) -> StorageResult<TurnRow> {
    let turn = turn(db, scope)?;
    if turn.state != "admitted" || turn.fence != 0 {
        return Err(error(
            StorageCode::DurableWorkTurnFenced,
            format!(
                "Durable Work Turn is stopped or fenced (cancelled or execution fence changed): {}",
                scope.turn_id
            ),
        ));
    }
    Ok(turn)
}

pub(super) fn matches_scope(work: &WorkRow, scope: &WorkTurnScope) -> bool {
    work.session_id == scope.session_id
        && match &scope.project_ref {
            None => work.scope_kind == "session" && work.scope_ref == scope.session_id,
            Some(project) => work.scope_kind == "project" && work.scope_ref == *project,
        }
}

pub(super) fn next_revision(db: &Connection, table: &str, work_id: &str) -> StorageResult<u64> {
    debug_assert!(matches!(
        table,
        "btcc_guided_work_plan_revisions"
            | "btcc_guided_work_checkpoint_revisions"
            | "btcc_guided_work_review_revisions"
            | "btcc_guided_work_disposition_revisions"
    ));
    db.query_row(
        &format!("SELECT COALESCE(MAX(revision), 0) + 1 FROM {table} WHERE work_id = ?1"),
        [work_id],
        |row| row.get(0),
    )
    .map_err(StorageError::sqlite)
}

pub(super) fn latest_result_sequence(db: &Connection, work_id: &str) -> StorageResult<u64> {
    db.query_row(
        "SELECT COALESCE(MAX(sequence), 0) FROM btcc_guided_work_results WHERE work_id = ?1",
        [work_id],
        |row| row.get(0),
    )
    .map_err(StorageError::sqlite)
}

pub(super) fn effect_blocked(db: &Connection, work_id: &str) -> StorageResult<bool> {
    let blocked: Option<i64> = db.query_row("SELECT 1 FROM btcc_guided_work_effect_blockers WHERE work_id = ?1 AND status = 'unresolved' LIMIT 1", [work_id], |row| row.get(0)).optional().map_err(StorageError::sqlite)?;
    Ok(blocked.is_some())
}

pub(super) fn preserve_blocked(
    db: &Connection,
    work_id: &str,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    if effect_blocked(db, work_id)? {
        db.execute("UPDATE btcc_guided_works SET status = 'blocked', updated_at = ?1 WHERE work_id = ?2 AND status = 'open'", params![clock(), work_id]).map_err(StorageError::sqlite)?;
    }
    Ok(())
}
