use crate::store::Result;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub use crate::work_schema::WRITER_EPOCH;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CutoverState {
    Pending,
    BackingUp,
    Importing,
    Done,
    PostponedNoSpace,
    FailedBackup,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupFailureCode {
    Copy,
    Worker,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CutoverStatus {
    pub state: CutoverState,
    pub needs_source: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<BackupFailureCode>,
}

/// Must precede all schema writes, including forward migrations.
pub fn check_epoch(db: &Connection) -> Result<()> {
    Ok(crate::work_schema::check_epoch(db)?)
}

pub fn status(db: &Connection) -> Result<CutoverStatus> {
    let row = db
        .query_row(super::sql::STATUS, [], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .optional()?;
    let Some((state, needs_source)) = row else {
        return Ok(CutoverStatus {
            state: CutoverState::Pending,
            needs_source: serde_json::json!([]),
            failure_code: None,
        });
    };
    let failure_code = match state.as_str() {
        "failed_backup_copy" => Some(BackupFailureCode::Copy),
        "failed_backup_worker" => Some(BackupFailureCode::Worker),
        _ => None,
    };
    let state = match state.as_str() {
        "complete" => CutoverState::Done,
        "importing" | "needs_source" => CutoverState::Importing,
        "failed_backup_copy" | "failed_backup_worker" => CutoverState::FailedBackup,
        "backing_up" => CutoverState::BackingUp,
        "postponed_no_space" => CutoverState::PostponedNoSpace,
        _ => CutoverState::Pending,
    };
    Ok(CutoverStatus {
        state,
        needs_source: serde_json::from_str(&needs_source)?,
        failure_code,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reimport {
    Skip,
    InPlace,
    Separate,
}

pub fn reimport(
    source_hash: &str,
    imported_hash: &str,
    revision: i64,
    imported_revision: i64,
) -> Reimport {
    if source_hash == imported_hash {
        Reimport::Skip
    } else if revision == imported_revision {
        Reimport::InPlace
    } else {
        Reimport::Separate
    }
}

/// The next start retries backup; the connection-local legacy writer fence stays.
pub fn fail_backup(tx: &crate::store::Transaction<'_>, code: BackupFailureCode) -> Result<()> {
    let state = match code {
        BackupFailureCode::Copy => "failed_backup_copy",
        BackupFailureCode::Worker => "failed_backup_worker",
    };
    tx.execute(super::sql::FAIL_BACKUP, [state])?;
    Ok(())
}
