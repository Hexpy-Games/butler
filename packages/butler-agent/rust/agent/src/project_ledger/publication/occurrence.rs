//! Durable v2 occurrence and attempt admission. The SQLite shard is only a
//! short-lived cross-process admission lock; the JSON occurrence is authority.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::btcc::{
    ProjectWorkOperationIdentity, ProjectWorkOperationKind, ResolvedProjectWorkScope,
};

use super::contracts::{
    ProjectLedgerRecordUpdate, ProjectWorkPublicationError, ProjectWorkTarget,
    ProjectWorkTargetState,
};
use super::record::{self, ProjectWorkHead};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(super) struct Attempt {
    pub number: usize,
    pub status: String,
    pub request_sha256: String,
    pub publication_id: String,
    pub expected_base: ProjectWorkHead,
    pub target_preconditions: Vec<ProjectWorkTarget>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(super) struct Occurrence {
    pub schema: String,
    pub ledger_project_id: String,
    pub ledger_root: String,
    pub operation_identity: LogicalIdentity,
    pub occurrence_id: String,
    pub status: String,
    pub attempts: Vec<Attempt>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LogicalIdentity {
    pub kind: String,
    pub id: String,
}

pub(super) fn read(
    data_root: &Path,
    scope: &ResolvedProjectWorkScope,
    identity: &ProjectWorkOperationIdentity,
) -> Result<Option<Occurrence>, ProjectWorkPublicationError> {
    let path = path(data_root, &occurrence_id(scope, identity)?);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(io()),
    };
    let stored: Occurrence = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    validate(&stored, scope, identity)?;
    Ok(Some(stored))
}

pub(super) fn reject_legacy(
    data_root: &Path,
    original_root: &Path,
    canonical_root: &Path,
    effect_key: &str,
) -> Result<(), ProjectWorkPublicationError> {
    for project_root in [original_root, canonical_root] {
        let id = digest(&json!({
            "effectKey": effect_key,
            "projectRoot": project_root.to_string_lossy(),
            "schema": "butler.btcc-project-ledger-effect.v1",
        }))?;
        if data_root
            .join("runtime/btcc-project-ledger-effects/occurrences")
            .join(format!("{id}.json"))
            .exists()
        {
            return Err(ProjectWorkPublicationError::Uncertain);
        }
    }
    Ok(())
}

pub(super) fn admit(
    data_root: &Path,
    scope: &ResolvedProjectWorkScope,
    identity: &ProjectWorkOperationIdentity,
    updates: &[super::contracts::ProjectLedgerRecordUpdate],
    collation: &crate::locale::LocaleCollation,
) -> Result<Occurrence, ProjectWorkPublicationError> {
    let (base, targets) = record::capture(scope, updates, collation)?;
    let occurrence_id = occurrence_id(scope, identity)?;
    let candidate = Occurrence {
        schema: "butler.btcc-project-ledger-effect-occurrence.v2".into(),
        ledger_project_id: scope.ledger_project_id.clone(),
        ledger_root: scope.ledger_root.to_string_lossy().into_owned(),
        operation_identity: logical(identity),
        occurrence_id: occurrence_id.clone(),
        status: "pending".into(),
        attempts: vec![attempt(1, identity, &occurrence_id, base, targets)?],
    };
    with_lock(data_root, &occurrence_id, || {
        if let Some(stored) = read(data_root, scope, identity)? {
            if stored.attempts[0].publication_id != candidate.attempts[0].publication_id {
                return Err(conflict());
            }
            return Ok(stored);
        }
        atomic_json(&path(data_root, &occurrence_id), &candidate)?;
        Ok(candidate)
    })
}

pub(super) fn append(
    data_root: &Path,
    scope: &ResolvedProjectWorkScope,
    identity: &ProjectWorkOperationIdentity,
    previous: &Occurrence,
    updates: &[super::contracts::ProjectLedgerRecordUpdate],
    collation: &crate::locale::LocaleCollation,
) -> Result<Occurrence, ProjectWorkPublicationError> {
    let (base, targets) = record::capture(scope, updates, collation)?;
    let new_attempt = attempt(
        previous.attempts.len() + 1,
        identity,
        &previous.occurrence_id,
        base,
        targets,
    )?;
    with_lock(data_root, &previous.occurrence_id, || {
        let mut stored = read(data_root, scope, identity)?.ok_or_else(invalid)?;
        if stored.attempts.len() != previous.attempts.len() {
            return Err(conflict());
        }
        stored.attempts.push(new_attempt);
        atomic_json(&path(data_root, &previous.occurrence_id), &stored)?;
        Ok(stored)
    })
}

fn validate(
    stored: &Occurrence,
    scope: &ResolvedProjectWorkScope,
    identity: &ProjectWorkOperationIdentity,
) -> Result<(), ProjectWorkPublicationError> {
    if stored.schema != "butler.btcc-project-ledger-effect-occurrence.v2"
        || stored.status != "pending"
        || stored.ledger_project_id != scope.ledger_project_id
        || stored.ledger_root != scope.ledger_root.to_string_lossy()
        || stored.operation_identity != logical(identity)
        || stored.occurrence_id != occurrence_id(scope, identity)?
        || stored.attempts.is_empty()
    {
        return Err(invalid());
    }
    for (index, attempt) in stored.attempts.iter().enumerate() {
        if attempt.number != index + 1
            || attempt.status != "admitted"
            || attempt.request_sha256 != identity.request_sha256
            || attempt.publication_id != publication_id(&stored.occurrence_id, attempt)?
            || attempt.expected_base.project_root != stored.ledger_root
            || attempt.expected_base.schema != "butler.btcc-project-ledger-head.v1"
            || attempt.expected_base.storage_authority.is_some()
            || !is_sha(&attempt.expected_base.source_sha256)
            || !is_sha(&attempt.expected_base.storage_sha256)
            || !is_sha(&attempt.request_sha256)
        {
            return Err(conflict());
        }
        let mut expected_paths = vec!["project.json".to_owned()];
        for target in &attempt.target_preconditions {
            let mut update = ProjectLedgerRecordUpdate::new(target.id.clone());
            update.kind = Some(target.kind.clone());
            update.parent_id = target.parent_id.clone();
            if record::target(scope, &update)?.path != target.path
                || (target.state == ProjectWorkTargetState::Present)
                    != target
                        .raw_record_sha256
                        .as_ref()
                        .is_some_and(|hash| is_sha(hash))
            {
                return Err(invalid());
            }
            expected_paths.push(record::relative(scope, &target.path)?.to_owned());
        }
        expected_paths.sort();
        expected_paths.dedup();
        if attempt.target_preconditions.is_empty()
            || expected_paths.len() != attempt.target_preconditions.len() + 1
            || expected_paths != attempt.expected_base.record_paths
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn is_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn attempt(
    number: usize,
    identity: &ProjectWorkOperationIdentity,
    occurrence_id: &str,
    expected_base: ProjectWorkHead,
    target_preconditions: Vec<ProjectWorkTarget>,
) -> Result<Attempt, ProjectWorkPublicationError> {
    let mut attempt = Attempt {
        number,
        status: "admitted".into(),
        request_sha256: identity.request_sha256.clone(),
        publication_id: String::new(),
        expected_base,
        target_preconditions,
    };
    attempt.publication_id = publication_id(occurrence_id, &attempt)?;
    Ok(attempt)
}

fn occurrence_id(
    scope: &ResolvedProjectWorkScope,
    identity: &ProjectWorkOperationIdentity,
) -> Result<String, ProjectWorkPublicationError> {
    digest(&json!({
        "ledgerProjectId": scope.ledger_project_id,
        "operationKind": operation_kind(identity.kind),
        "operationId": identity.id,
    }))
}

fn publication_id(
    occurrence_id: &str,
    attempt: &Attempt,
) -> Result<String, ProjectWorkPublicationError> {
    digest(&json!({
        "schema": "butler.btcc-project-ledger-effect-publication.v2",
        "occurrenceId": occurrence_id,
        "attemptNumber": attempt.number,
        "requestSha256": attempt.request_sha256,
        "expectedBase": attempt.expected_base,
        "targetPreconditions": attempt.target_preconditions,
    }))
}

fn logical(identity: &ProjectWorkOperationIdentity) -> LogicalIdentity {
    LogicalIdentity {
        kind: operation_kind(identity.kind).into(),
        id: identity.id.clone(),
    }
}

fn operation_kind(kind: ProjectWorkOperationKind) -> &'static str {
    match kind {
        ProjectWorkOperationKind::MutationCall => "mutation_call",
        ProjectWorkOperationKind::BindingRevision => "binding_revision",
        ProjectWorkOperationKind::CloseoutDiagnostic => "closeout_diagnostic",
        ProjectWorkOperationKind::Abandonment => "abandonment",
        ProjectWorkOperationKind::LegacyImport => "legacy_import",
    }
}

fn digest(value: &serde_json::Value) -> Result<String, ProjectWorkPublicationError> {
    let encoded = crate::json::stringify(value).map_err(|_| invalid())?;
    Ok(format!("{:x}", Sha256::digest(encoded.as_bytes())))
}

fn path(root: &Path, occurrence_id: &str) -> PathBuf {
    root.join("runtime/btcc-project-ledger-effects-v2/occurrences")
        .join(format!("{occurrence_id}.json"))
}

pub(super) fn atomic_json(
    path: &Path,
    value: &impl Serialize,
) -> Result<(), ProjectWorkPublicationError> {
    let parent = path.parent().ok_or_else(io)?;
    fs::create_dir_all(parent).map_err(|_| io())?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|_| invalid())?;
    bytes.push(b'\n');
    let result = fs::write(&temporary, bytes).and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| io())
}

pub(super) fn with_lock<T>(
    root: &Path,
    id: &str,
    action: impl FnOnce() -> Result<T, ProjectWorkPublicationError>,
) -> Result<T, ProjectWorkPublicationError> {
    let canonical_root = fs::canonicalize(root).map_err(|_| io())?;
    let logical = canonical_root
        .join("runtime/btcc-project-ledger-effects-v2/admission-locks")
        .join(id);
    let digest = Sha256::digest(logical.to_string_lossy().as_bytes());
    let shard = u32::from_be_bytes(digest[..4].try_into().map_err(|_| invalid())?) % 64;
    let directory = canonical_root.join("runtime/mutation-lock-shards");
    for parent in [canonical_root.join("runtime"), directory.clone()] {
        if parent.exists()
            && fs::symlink_metadata(&parent)
                .map_err(|_| io())?
                .file_type()
                .is_symlink()
        {
            return Err(ProjectWorkPublicationError::Uncertain);
        }
    }
    fs::create_dir_all(&directory).map_err(|_| io())?;
    if !fs::canonicalize(&directory)
        .map_err(|_| io())?
        .starts_with(&canonical_root)
    {
        return Err(ProjectWorkPublicationError::Uncertain);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(|_| io())?;
    }
    let shard = directory.join(format!("mutation-lock-{shard:02}.sqlite3"));
    if shard.exists()
        && fs::symlink_metadata(&shard)
            .map_err(|_| io())?
            .file_type()
            .is_symlink()
    {
        return Err(ProjectWorkPublicationError::Uncertain);
    }
    let mut connection = Connection::open(&shard).map_err(|_| io())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&shard, fs::Permissions::from_mode(0o600)).map_err(|_| io())?;
    }
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|_| io())?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS shard_fence(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL); INSERT OR IGNORE INTO shard_fence VALUES(1,0); CREATE TABLE IF NOT EXISTS active_lock(lock_key TEXT PRIMARY KEY, ownership_token TEXT NOT NULL, owner_id TEXT NOT NULL, acquired_at TEXT NOT NULL, renewed_at TEXT NOT NULL);").map_err(|_| io())?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| conflict())?;
    tx.execute(
        "UPDATE shard_fence SET generation=generation+1 WHERE singleton=1",
        [],
    )
    .map_err(|_| io())?;
    let token = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT OR REPLACE INTO active_lock(lock_key,ownership_token,owner_id,acquired_at,renewed_at) VALUES(?1,?2,?3,datetime('now'),datetime('now'))", params![logical.to_string_lossy().as_ref(), token, "native-project-ledger"]).map_err(|_| io())?;
    let result = match action() {
        Ok(value) => value,
        Err(error) => {
            let _ = tx.rollback();
            return Err(error);
        }
    };
    tx.execute(
        "DELETE FROM active_lock WHERE lock_key=?1 AND ownership_token=?2",
        params![logical.to_string_lossy().as_ref(), token],
    )
    .map_err(|_| io())?;
    tx.commit().map_err(|_| io())?;
    Ok(result)
}

fn invalid() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::Adapter("project_ledger_occurrence_invalid")
}
fn conflict() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::Adapter("project_ledger_effect_occurrence_conflict")
}
fn io() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::Io("project_ledger_occurrence_io_error")
}
