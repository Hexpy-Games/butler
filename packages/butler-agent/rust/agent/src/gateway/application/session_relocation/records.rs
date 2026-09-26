//! Durable relocation state stored on the existing App database lane.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use super::super::{
    AppRelocateSessionRequest, AppRelocationBinding, AppRelocationSnapshot,
    AppRelocationWorkspacePlan, AppStorageError, app_error,
};
use crate::gateway::{GatewayApplicationError, application::space};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Before {
    pub binding: Option<AppRelocationBinding>,
    pub project_id: Option<String>,
    pub parent_key: Option<String>,
    pub owner_pid: u32,
}

pub(super) type Destination = space::AppRelocationDestination;

#[derive(Clone, Debug)]
pub(super) struct Row {
    pub operation_id: String,
    pub session_id: String,
    pub phase: String,
    pub from_json: String,
    pub to_json: String,
    pub prepared_json: Option<String>,
}

pub(super) fn validate(
    db: &Connection,
    request: &AppRelocateSessionRequest,
) -> Result<(), GatewayApplicationError> {
    let view = space::read_view(db).map_err(app_error)?;
    validate_target(db, request, &view).map(|_| ())
}

pub(super) fn reserve(
    db: &mut Connection,
    request: &AppRelocateSessionRequest,
    snapshot: &AppRelocationSnapshot,
) -> Result<Row, GatewayApplicationError> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let view = space::read_view(&tx).map_err(app_error)?;
    let (session, destination, source_parent) = validate_target(&tx, request, &view)?;
    if snapshot.active_execution || snapshot.open_child {
        return Err(relocation_error(
            "session_busy",
            "진행 중인 작업과 대기 메시지가 끝난 뒤 이동할 수 있습니다.",
        ));
    }
    // The Host observation can become stale before this transaction begins, so
    // App turn and queue facts are rechecked while holding the immediate write
    // transaction that claims the relocation gate.
    if has_active_or_queued_work(&tx, &request.session_id)? {
        return Err(relocation_error(
            "session_busy",
            "진행 중인 작업과 대기 메시지가 끝난 뒤 이동할 수 있습니다.",
        ));
    }
    let owner = gate_owner(&tx, &request.session_id)?;
    match owner.as_ref().map(|(kind, _)| kind.as_str()) {
        Some("relocate") => {
            return Err(relocation_error(
                "session_relocating",
                "대화를 이동하고 있습니다.",
            ));
        }
        Some("turn") | None => {}
        Some(_) => return Err(GatewayApplicationError::Internal),
    }
    let before = Before {
        binding: snapshot.binding.clone(),
        project_id: session.project_id.clone(),
        parent_key: source_parent,
        owner_pid: std::process::id(),
    };
    let to = Destination {
        parent_key: destination.parent_key,
        target_key: destination.target_key,
        position: destination.position,
        project: destination.project,
    };
    let before_json = serde_json::to_string(&before).map_err(json_error)?;
    let to_json = serde_json::to_string(&to).map_err(json_error)?;
    if let Some((kind, owner_id)) = owner.filter(|(kind, _)| kind == "turn") {
        tx.execute(
            "DELETE FROM app_session_context_gate WHERE session_id=?1 AND owner_kind=?2 AND owner_id=?3",
            params![request.session_id, kind, owner_id],
        )
        .map_err(sqlite_error)?;
    }
    tx.execute(
        "INSERT INTO app_session_context_gate(session_id,owner_kind,owner_id) VALUES(?1,'relocate',?2)",
        params![request.session_id, request.operation_id],
    )
    .map_err(|error| {
        if error.to_string().contains("UNIQUE constraint failed") {
            relocation_error("session_relocating", "대화를 이동하고 있습니다.")
        } else {
            sqlite_error(error)
        }
    })?;
    tx.execute(
        "INSERT INTO app_session_relocations(operation_id,session_id,phase,from_json,to_json,prepared_json,error_code) VALUES(?1,?2,'preparing',?3,?4,NULL,NULL)",
        params![request.operation_id, request.session_id, before_json, to_json],
    )
    .map_err(|error| {
        if error.to_string().contains("UNIQUE constraint failed") {
            relocation_error("session_relocating", "대화를 이동하고 있습니다.")
        } else {
            sqlite_error(error)
        }
    })?;
    let row = read_row(&tx, &request.operation_id)?.ok_or(GatewayApplicationError::Internal)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(row)
}

pub(super) fn read_row(
    db: &Connection,
    operation_id: &str,
) -> Result<Option<Row>, GatewayApplicationError> {
    db.query_row(
        "SELECT operation_id,session_id,phase,from_json,to_json,prepared_json FROM app_session_relocations WHERE operation_id=?1",
        [operation_id],
        |row| {
            Ok(Row {
                operation_id: row.get(0)?,
                session_id: row.get(1)?,
                phase: row.get(2)?,
                from_json: row.get(3)?,
                to_json: row.get(4)?,
                prepared_json: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(sqlite_error)
}

pub(super) fn decode_before(row: &Row) -> Result<Before, GatewayApplicationError> {
    serde_json::from_str(&row.from_json).map_err(json_error)
}

pub(super) fn decode_destination(row: &Row) -> Result<Destination, GatewayApplicationError> {
    serde_json::from_str(&row.to_json).map_err(json_error)
}

pub(super) fn pending(db: &Connection) -> Result<Vec<Row>, GatewayApplicationError> {
    let mut statement = db
        .prepare(
            "SELECT operation_id,session_id,phase,from_json,to_json,prepared_json FROM app_session_relocations WHERE phase IN ('preparing','prepared','bound') OR (phase='aborted' AND prepared_json IS NOT NULL) ORDER BY rowid",
        )
        .map_err(sqlite_error)?;
    statement
        .query_map([], |row| {
            Ok(Row {
                operation_id: row.get(0)?,
                session_id: row.get(1)?,
                phase: row.get(2)?,
                from_json: row.get(3)?,
                to_json: row.get(4)?,
                prepared_json: row.get(5)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)
}

pub(super) fn store_binding(
    db: &mut Connection,
    operation_id: &str,
    binding: AppRelocationBinding,
) -> Result<(), GatewayApplicationError> {
    let tx = db.transaction().map_err(sqlite_error)?;
    let mut row = read_row(&tx, operation_id)?.ok_or(GatewayApplicationError::Internal)?;
    let mut before: Before = serde_json::from_str(&row.from_json).map_err(json_error)?;
    before.binding = Some(binding);
    row.from_json = serde_json::to_string(&before).map_err(json_error)?;
    tx.execute(
        "UPDATE app_session_relocations SET from_json=?1 WHERE operation_id=?2 AND phase='preparing'",
        params![row.from_json, operation_id],
    )
    .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)
}

pub(super) fn store_plan(
    db: &mut Connection,
    operation_id: &str,
    plan: &AppRelocationWorkspacePlan,
) -> Result<(), GatewayApplicationError> {
    let encoded = serde_json::to_string(plan).map_err(json_error)?;
    db.execute(
        "UPDATE app_session_relocations SET prepared_json=?1 WHERE operation_id=?2 AND phase='preparing'",
        params![encoded, operation_id],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

pub(super) fn set_phase(
    db: &mut Connection,
    operation_id: &str,
    phase: &str,
) -> Result<(), GatewayApplicationError> {
    db.execute(
        "UPDATE app_session_relocations SET phase=?1 WHERE operation_id=?2 AND phase IN ('preparing','prepared','bound')",
        params![phase, operation_id],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

pub(super) fn abort(
    db: &mut Connection,
    row: &Row,
    error_code: &str,
) -> Result<(), GatewayApplicationError> {
    let tx = db.transaction().map_err(sqlite_error)?;
    tx.execute(
        "UPDATE app_session_relocations SET phase='aborted',error_code=?1 WHERE operation_id=?2 AND phase IN ('preparing','prepared','bound')",
        params![error_code, row.operation_id],
    )
    .map_err(sqlite_error)?;
    tx.execute(
        "DELETE FROM app_session_context_gate WHERE session_id=?1 AND owner_kind='relocate' AND owner_id=?2",
        params![row.session_id, row.operation_id],
    )
    .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)
}

pub(super) fn mark_conflict(
    db: &Connection,
    operation_id: &str,
) -> Result<(), GatewayApplicationError> {
    db.execute(
        "UPDATE app_session_relocations SET error_code='session_context_conflict' WHERE operation_id=?1",
        [operation_id],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

pub(super) fn clear_plan(
    db: &Connection,
    operation_id: &str,
) -> Result<(), GatewayApplicationError> {
    db.execute(
        "UPDATE app_session_relocations SET prepared_json=NULL WHERE operation_id=?1 AND phase='aborted'",
        [operation_id],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

fn validate_target(
    db: &Connection,
    request: &AppRelocateSessionRequest,
    view: &space::AppSpaceView,
) -> Result<
    (
        crate::gateway::AppSessionSummary,
        space::AppRelocationDestination,
        Option<String>,
    ),
    GatewayApplicationError,
> {
    if view.revision != request.expected_revision {
        return Err(relocation_error(
            "space_changed",
            "목록이 변경되었습니다. 다시 이동해 주세요.",
        ));
    }
    let session =
        super::super::sessions::read_summary(db, &request.session_id).map_err(app_error)?;
    if session.archived || request.session_id == "general" {
        return Err(relocation_error(
            "session_not_movable",
            "이 대화는 이동할 수 없습니다.",
        ));
    }
    let source_key = format!("s:{}", request.session_id);
    let source_parent = space::require_node(view, &source_key)?.parent_key.clone();
    let destination = space::relocation_destination(
        db,
        view,
        &request.session_id,
        request.target_key.as_deref(),
        request.position,
    )?;
    Ok((session, destination, source_parent))
}

fn has_active_or_queued_work(
    db: &Connection,
    session_id: &str,
) -> Result<bool, GatewayApplicationError> {
    let active: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM turns WHERE chat_id=?1 AND (state NOT IN ('delivered','cancelled','failed','runtime_fault') OR retryable=1))",
            [session_id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    let queued: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM session_queued_messages WHERE chat_id=?1 AND state IN ('queued','dispatching'))",
            [session_id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    Ok(active || queued)
}

fn gate_owner(
    db: &Connection,
    session_id: &str,
) -> Result<Option<(String, String)>, GatewayApplicationError> {
    db.query_row(
        "SELECT owner_kind,owner_id FROM app_session_context_gate WHERE session_id=?1",
        [session_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(sqlite_error)
}

fn sqlite_error(error: rusqlite::Error) -> GatewayApplicationError {
    app_error(AppStorageError::sqlite(error))
}

fn json_error(_error: serde_json::Error) -> GatewayApplicationError {
    GatewayApplicationError::Internal
}

fn relocation_error(code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}
