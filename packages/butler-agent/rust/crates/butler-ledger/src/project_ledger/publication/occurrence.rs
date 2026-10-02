//! Durable v2 occurrence and attempt admission. The SQLite shard is only a
//! short-lived cross-process admission lock; the JSON occurrence is authority.

use butler_platform::sqlite;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use butler_platform::secure_fs;
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use butler_turn::btcc::{
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
    let stored: Occurrence =
        serde_json::from_slice(&bytes).map_err(|source| invalid().with_source(source))?;
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
            return Err(ProjectWorkPublicationError::Uncertain { source: None });
        }
    }
    Ok(())
}

pub(super) fn admit(
    data_root: &Path,
    scope: &ResolvedProjectWorkScope,
    identity: &ProjectWorkOperationIdentity,
    updates: &[super::contracts::ProjectLedgerRecordUpdate],
    collation: &butler_core::locale::LocaleCollation,
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
            if stored
                .attempts
                .first()
                .map(|attempt| &attempt.publication_id)
                != candidate
                    .attempts
                    .first()
                    .map(|attempt| &attempt.publication_id)
            {
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
    collation: &butler_core::locale::LocaleCollation,
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
        || Path::new(&stored.ledger_root) != scope.ledger_root
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
            update.kind = Some(target.kind);
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
    let encoded =
        butler_core::json::stringify(value).map_err(|source| invalid().with_source(source))?;
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
    fs::create_dir_all(parent).map_err(|source| io().with_source(source))?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|source| invalid().with_source(source))?;
    bytes.push(b'\n');
    let result = fs::write(&temporary, bytes).and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|source| io().with_source(source))
}

/// Runs `action` while holding the SQLite admission lock for `id`: one of
/// 64 shard databases under the canonical data root, each with a fence
/// generation bumped on every acquisition and one row per held lock.
pub(super) fn with_lock<T>(
    root: &Path,
    id: &str,
    action: impl FnOnce() -> Result<T, ProjectWorkPublicationError>,
) -> Result<T, ProjectWorkPublicationError> {
    let canonical_root = butler_platform::secure_fs::canonicalize(root)
        .map_err(|source| io().with_source(source))?;
    let logical = canonical_root
        .join("runtime/btcc-project-ledger-effects-v2/admission-locks")
        .join(id);
    let mut connection = open_shard(&canonical_root, &logical)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|source| conflict().with_source(source))?;
    tx.execute(
        "UPDATE shard_fence SET generation=generation+1 WHERE singleton=1",
        [],
    )
    .map_err(|source| io().with_source(source))?;
    let token = uuid::Uuid::new_v4().to_string();
    let key = logical.to_string_lossy();
    tx.execute("INSERT OR REPLACE INTO active_lock(lock_key,ownership_token,owner_id,acquired_at,renewed_at) VALUES(?1,?2,?3,datetime('now'),datetime('now'))", params![key.as_ref(), token, "native-project-ledger"]).map_err(|source| io().with_source(source))?;
    let result = match action() {
        Ok(value) => value,
        Err(error) => {
            let _ = tx.rollback();
            return Err(error);
        }
    };
    tx.execute(
        "DELETE FROM active_lock WHERE lock_key=?1 AND ownership_token=?2",
        params![key.as_ref(), token],
    )
    .map_err(|source| io().with_source(source))?;
    tx.commit().map_err(|source| io().with_source(source))?;
    Ok(result)
}

/// The shard database `logical` hashes to, created with its schema and
/// owner-only permissions; symlinked shards or directories are refused.
fn open_shard(
    canonical_root: &Path,
    logical: &Path,
) -> Result<Connection, ProjectWorkPublicationError> {
    let digest = Sha256::digest(logical.to_string_lossy().as_bytes());
    let prefix: [u8; 4] = digest
        .get(..4)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(invalid)?;
    let shard = u32::from_be_bytes(prefix) % 64;
    let directory = canonical_root.join("runtime/mutation-lock-shards");
    for parent in [canonical_root.join("runtime"), directory.clone()] {
        if is_symlink(&parent)? {
            return Err(ProjectWorkPublicationError::Uncertain { source: None });
        }
    }
    fs::create_dir_all(&directory).map_err(|source| io().with_source(source))?;
    if !butler_platform::secure_fs::canonicalize(&directory)
        .map_err(|source| io().with_source(source))?
        .starts_with(canonical_root)
    {
        return Err(ProjectWorkPublicationError::Uncertain { source: None });
    }
    secure_fs::restrict_directory(&directory)
        .transpose()
        .map_err(|source| io().with_source(source))?;
    let shard = directory.join(format!("mutation-lock-{shard:02}.sqlite3"));
    if is_symlink(&shard)? {
        return Err(ProjectWorkPublicationError::Uncertain { source: None });
    }
    let connection = sqlite::open(&shard).map_err(|source| io().with_source(source))?;
    secure_fs::restrict_file(&shard)
        .transpose()
        .map_err(|source| io().with_source(source))?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|source| io().with_source(source))?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS shard_fence(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL); INSERT OR IGNORE INTO shard_fence VALUES(1,0); CREATE TABLE IF NOT EXISTS active_lock(lock_key TEXT PRIMARY KEY, ownership_token TEXT NOT NULL, owner_id TEXT NOT NULL, acquired_at TEXT NOT NULL, renewed_at TEXT NOT NULL);").map_err(|source| io().with_source(source))?;
    Ok(connection)
}

/// Whether `path` exists as a symlink.
fn is_symlink(path: &Path) -> Result<bool, ProjectWorkPublicationError> {
    if !path.exists() {
        return Ok(false);
    }
    Ok(fs::symlink_metadata(path)
        .map_err(|source| io().with_source(source))?
        .file_type()
        .is_symlink())
}

fn invalid() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::adapter("project_ledger_occurrence_invalid")
}
fn conflict() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::adapter("project_ledger_effect_occurrence_conflict")
}
fn io() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::io("project_ledger_occurrence_io_error")
}
