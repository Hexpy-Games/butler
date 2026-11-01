//! Durable v2 occurrence and attempt admission. The SQLite shard is only a
//! short-lived cross-process admission lock; the JSON occurrence is authority.

use crate::project_ledger::publication::timing::fs;
use butler_platform::sqlite;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::TransactionBehavior;
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
    let _phase = crate::project_ledger::publication::timing::Phase::new("publication_read");
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
        if fs::exists(
            data_root
                .join("runtime/btcc-project-ledger-effects/occurrences")
                .join(format!("{id}.json")),
        ) {
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
    let _phase = crate::project_ledger::publication::timing::Phase::new("publication_admit");
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
            || !matches!(
                attempt.expected_base.schema.as_str(),
                "butler.btcc-project-ledger-head.v1" | "butler.btcc-project-ledger-head.v2"
            )
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
    let _phase = crate::project_ledger::publication::timing::Phase::new("publication_atomic_json");
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

/// Runs `action` under the same cross-process SQLite write reservation as
/// legacy writers. SQL is only a mutex: the occurrence JSON is authority.
/// Rolling back releases the reservation without a redundant durable commit.
pub(super) fn with_lock<T>(
    root: &Path,
    id: &str,
    action: impl FnOnce() -> Result<T, ProjectWorkPublicationError>,
) -> Result<T, ProjectWorkPublicationError> {
    let _phase = super::timing::Phase::new("publication_admission_lock");
    let canonical_root = fs::canonicalize(root).map_err(|source| io().with_source(source))?;
    let logical = canonical_root
        .join("runtime/btcc-project-ledger-effects-v2/admission-locks")
        .join(id);
    let mut connection = open_shard(&canonical_root, &logical)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|source| conflict().with_source(source))?;
    let result = action();
    let release = {
        let _unlock = super::timing::Phase::new("publication_admission_unlock");
        tx.rollback().map_err(|source| io().with_source(source))
    };
    {
        let _close = super::timing::Phase::new("publication_shard_close");
        drop(connection);
    }
    match result {
        Ok(value) => {
            release?;
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

/// The shard database `logical` hashes to, with owner-only permissions;
/// symlinked shards or directories are refused. Existing schemas and journal
/// modes remain untouched, so legacy writers retain the same lock domain.
fn open_shard(
    canonical_root: &Path,
    logical: &Path,
) -> Result<sqlite::Connection, ProjectWorkPublicationError> {
    let _phase = super::timing::Phase::new("publication_shard_open");
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
    let resolved = fs::canonicalize(&directory).map_err(|source| io().with_source(source))?;
    if !butler_platform::secure_fs::is_within(&resolved, canonical_root) {
        return Err(ProjectWorkPublicationError::Uncertain { source: None });
    }
    fs::restrict_directory(&directory)
        .transpose()
        .map_err(|source| io().with_source(source))?;
    let shard = directory.join(format!("mutation-lock-{shard:02}.sqlite3"));
    if is_symlink(&shard)? {
        return Err(ProjectWorkPublicationError::Uncertain { source: None });
    }
    let connection = sqlite::open(&shard).map_err(|source| io().with_source(source))?;
    fs::restrict_file(&shard)
        .transpose()
        .map_err(|source| io().with_source(source))?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|source| io().with_source(source))?;
    connection
        .execute_batch("PRAGMA synchronous=FULL;")
        .map_err(|source| io().with_source(source))?;
    // A mutex-only connection must not checkpoint another writer's WAL on
    // close. Committed WAL data retains its existing FULL durability.
    connection
        .set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true,
        )
        .map_err(|source| io().with_source(source))?;
    Ok(connection)
}

/// Whether `path` exists as a symlink.
fn is_symlink(path: &Path) -> Result<bool, ProjectWorkPublicationError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(io().with_source(source)),
    }
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
