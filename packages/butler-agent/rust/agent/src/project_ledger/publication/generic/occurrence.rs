use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::contracts::LedgerEffectError;
use super::digest;
use super::head::LedgerHead;
use super::scope::LedgerScope;
use crate::project_ledger::publication::contracts::{
    ProjectWorkPublicationError, ProjectWorkTarget,
};
use crate::project_ledger::publication::occurrence as shared;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Occurrence {
    pub schema: String,
    pub ledger_project_id: String,
    pub ledger_root: String,
    pub operation_identity: Identity,
    pub occurrence_id: String,
    pub status: String,
    pub attempts: Vec<Attempt>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Identity {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Attempt {
    pub number: usize,
    pub status: String,
    pub request_sha256: String,
    pub publication_id: String,
    pub expected_base: LedgerHead,
    pub target_preconditions: Vec<ProjectWorkTarget>,
}

pub(super) fn read(
    data_root: &Path,
    scope: &LedgerScope,
    effect_key: &str,
    request_sha256: &str,
) -> Result<Option<Occurrence>, LedgerEffectError> {
    let id = occurrence_id(scope, effect_key)?;
    let bytes = match fs::read(path(data_root, &id)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(LedgerEffectError::Uncertain),
    };
    let stored: Occurrence =
        serde_json::from_slice(&bytes).map_err(|_| LedgerEffectError::Uncertain)?;
    if stored.schema != "butler.btcc-project-ledger-effect-occurrence.v2"
        || stored.status != "pending"
        || stored.ledger_project_id != scope.project_id
        || stored.ledger_root != scope.root.to_string_lossy()
        || stored.operation_identity.kind != "mutation_call"
        || stored.operation_identity.id != effect_key
        || stored.occurrence_id != id
        || stored.attempts.is_empty()
    {
        return Err(LedgerEffectError::Uncertain);
    }
    for (index, attempt) in stored.attempts.iter().enumerate() {
        if attempt.request_sha256 != request_sha256 {
            return Err(LedgerEffectError::Conflict);
        }
        if attempt.number != index + 1
            || attempt.status != "admitted"
            || attempt.expected_base.project_root != stored.ledger_root
            || attempt.expected_base.schema != "butler.btcc-project-ledger-head.v1"
            || attempt.expected_base.storage_authority.is_some()
            || attempt.target_preconditions.is_empty()
            || attempt.publication_id != publication_id(&id, attempt)?
        {
            return Err(LedgerEffectError::Uncertain);
        }
        let mut seen = std::collections::HashSet::new();
        let prefix = format!("project-ledger/projects/{}/", scope.project_id);
        for target in &attempt.target_preconditions {
            let relative = target
                .path
                .strip_prefix(&prefix)
                .ok_or(LedgerEffectError::Uncertain)?;
            if relative.is_empty()
                || relative.contains('\\')
                || relative
                    .split('/')
                    .any(|part| part.is_empty() || matches!(part, "." | ".."))
                || !seen.insert((
                    target.kind.as_str(),
                    target.id.as_str(),
                    target.path.as_str(),
                ))
                || target
                    .raw_record_sha256
                    .as_ref()
                    .is_some_and(|hash| !is_sha(hash))
                || matches!(
                    &target.state,
                    crate::project_ledger::publication::contracts::ProjectWorkTargetState::Present
                ) != target.raw_record_sha256.is_some()
            {
                return Err(LedgerEffectError::Uncertain);
            }
        }
    }
    Ok(Some(stored))
}

pub(super) fn admit(
    data_root: &Path,
    scope: &LedgerScope,
    effect_key: &str,
    request_sha256: &str,
    base: LedgerHead,
    targets: Vec<ProjectWorkTarget>,
) -> Result<Occurrence, LedgerEffectError> {
    let id = occurrence_id(scope, effect_key)?;
    let candidate = Occurrence {
        schema: "butler.btcc-project-ledger-effect-occurrence.v2".into(),
        ledger_project_id: scope.project_id.clone(),
        ledger_root: scope.root.to_string_lossy().into_owned(),
        operation_identity: Identity {
            kind: "mutation_call".into(),
            id: effect_key.into(),
        },
        occurrence_id: id.clone(),
        status: "pending".into(),
        attempts: vec![attempt(1, &id, request_sha256, base, targets)?],
    };
    locked(data_root, &id, || {
        if let Some(existing) = read(data_root, scope, effect_key, request_sha256)? {
            if existing.attempts[0].publication_id != candidate.attempts[0].publication_id {
                return Err(LedgerEffectError::Conflict);
            }
            return Ok(existing);
        }
        shared::atomic_json(&path(data_root, &id), &candidate).map_err(convert)?;
        Ok(candidate)
    })
}

pub(super) fn append(
    data_root: &Path,
    scope: &LedgerScope,
    effect_key: &str,
    request_sha256: &str,
    previous: &Occurrence,
    base: LedgerHead,
    targets: Vec<ProjectWorkTarget>,
) -> Result<Occurrence, LedgerEffectError> {
    let next = attempt(
        previous.attempts.len() + 1,
        &previous.occurrence_id,
        request_sha256,
        base,
        targets,
    )?;
    locked(data_root, &previous.occurrence_id, || {
        let mut stored = read(data_root, scope, effect_key, request_sha256)?
            .ok_or(LedgerEffectError::Uncertain)?;
        if stored.attempts.len() != previous.attempts.len() {
            return Err(LedgerEffectError::Conflict);
        }
        stored.attempts.push(next);
        shared::atomic_json(&path(data_root, &previous.occurrence_id), &stored).map_err(convert)?;
        Ok(stored)
    })
}

pub(super) fn legacy_exists(
    data_root: &Path,
    original: &Path,
    canonical: &Path,
    effect_key: &str,
) -> Result<bool, LedgerEffectError> {
    for root in [original, canonical] {
        let id = json_hash(
            &json!({"effectKey":effect_key,"projectRoot":root.to_string_lossy(),"schema":"butler.btcc-project-ledger-effect.v1"}),
        )?;
        if data_root
            .join("runtime/btcc-project-ledger-effects/occurrences")
            .join(format!("{id}.json"))
            .exists()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn attempt(
    number: usize,
    id: &str,
    request_sha256: &str,
    expected_base: LedgerHead,
    target_preconditions: Vec<ProjectWorkTarget>,
) -> Result<Attempt, LedgerEffectError> {
    let mut attempt = Attempt {
        number,
        status: "admitted".into(),
        request_sha256: request_sha256.into(),
        publication_id: String::new(),
        expected_base,
        target_preconditions,
    };
    attempt.publication_id = publication_id(id, &attempt)?;
    Ok(attempt)
}

fn occurrence_id(scope: &LedgerScope, effect_key: &str) -> Result<String, LedgerEffectError> {
    json_hash(
        &json!({"ledgerProjectId":scope.project_id,"operationKind":"mutation_call","operationId":effect_key}),
    )
}

fn publication_id(id: &str, attempt: &Attempt) -> Result<String, LedgerEffectError> {
    json_hash(
        &json!({"schema":"butler.btcc-project-ledger-effect-publication.v2","occurrenceId":id,
        "attemptNumber":attempt.number,"requestSha256":attempt.request_sha256,
        "expectedBase":attempt.expected_base,"targetPreconditions":attempt.target_preconditions}),
    )
}

fn json_hash(value: &serde_json::Value) -> Result<String, LedgerEffectError> {
    let encoded = crate::json::stringify(value).map_err(|_| LedgerEffectError::Uncertain)?;
    Ok(digest::sha(encoded.as_bytes()))
}

fn path(root: &Path, id: &str) -> PathBuf {
    root.join("runtime/btcc-project-ledger-effects-v2/occurrences")
        .join(format!("{id}.json"))
}

fn is_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn locked<T>(
    data_root: &Path,
    id: &str,
    action: impl FnOnce() -> Result<T, LedgerEffectError>,
) -> Result<T, LedgerEffectError> {
    shared::with_lock(data_root, id, || {
        action().map_err(|error| match error {
            LedgerEffectError::Conflict => {
                ProjectWorkPublicationError::Adapter("project_ledger_effect_occurrence_conflict")
            }
            _ => ProjectWorkPublicationError::Uncertain,
        })
    })
    .map_err(convert)
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn convert(error: ProjectWorkPublicationError) -> LedgerEffectError {
    match error {
        ProjectWorkPublicationError::Adapter("project_ledger_effect_occurrence_conflict") => {
            LedgerEffectError::Conflict
        }
        _ => LedgerEffectError::Uncertain,
    }
}
