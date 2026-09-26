//! Immutable exact Project Work Result identities prepared from canonical Ledger records.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;

use crate::btcc::{
    ExactProjectWorkResultAuthority, ExactProjectWorkResultIdentity,
    ExactProjectWorkResultVerification, OperationResultReferenceInput, ResolvedProjectWorkScope,
    StorageError,
};

use super::{NativeProjectLedger, ProjectLedgerReadError, active_reference, work};

const RESULT_SCHEMA: &str = "butler.btcc-project-work-result-reference.v1";

pub(crate) async fn prepare_exact_project_work_result_authority(
    ledger: &NativeProjectLedger,
    scope: ResolvedProjectWorkScope,
    work_ids: Vec<String>,
) -> Result<Arc<dyn ExactProjectWorkResultAuthority>, StorageError> {
    let [work_id] = <[String; 1]>::try_from(work_ids)
        .map_err(|_| storage_error("operation_result_project_work_set_invalid"))?;
    let identities = ledger
        .run(move |data_root, collation| {
            let projects_root = data_root.join("project-ledger/projects");
            let expected_root = projects_root.join(&scope.ledger_project_id);
            if !active_reference::safe_id(&scope.ledger_project_id)
                || scope.ledger_root != expected_root
            {
                return Err(ProjectLedgerReadError::Resolution(
                    "active_project_ledger_path_escape",
                ));
            }
            active_reference::canonical_containment(&projects_root, &scope.ledger_root)?;
            if crate::public_text::trim_js_whitespace(&work_id).is_empty()
                || work_id.encode_utf16().count() > 4096
                || matches!(work_id.as_str(), "." | "..")
                || work_id.contains(['/', '\\'])
            {
                return Err(ProjectLedgerReadError::RecordShow(
                    "project_work_managed_record_invalid",
                ));
            }
            let snapshot = work::read_current_project_work(&scope, &work_id, collation)?.ok_or(
                super::ProjectLedgerReadError::RecordShow("project_work_record_missing"),
            )?;
            snapshot
                .children
                .values()
                .filter(|child| child.get("schema").and_then(Value::as_str) == Some(RESULT_SCHEMA))
                .map(identity_from_child)
                .collect::<Result<Vec<_>, _>>()
        })
        .await
        .map_err(read_error)?;
    assert_unique(&identities)?;
    Ok(Arc::new(PreparedProjectWorkResultAuthority { identities }))
}

struct PreparedProjectWorkResultAuthority {
    identities: Vec<ExactProjectWorkResultIdentity>,
}

impl ExactProjectWorkResultAuthority for PreparedProjectWorkResultAuthority {
    fn resolve(
        &self,
        input: &OperationResultReferenceInput,
    ) -> Result<Option<ExactProjectWorkResultIdentity>, StorageError> {
        let mut matches = self.identities.iter().filter(|identity| {
            identity.turn_id == input.turn_id && identity.tool_call_id == input.call_id
        });
        let found = matches.next().cloned();
        if matches.next().is_some() {
            return Err(storage_error("operation_result_project_identity_ambiguous"));
        }
        Ok(found)
    }

    fn verify(
        &self,
        input: &ExactProjectWorkResultVerification,
    ) -> Result<ExactProjectWorkResultIdentity, StorageError> {
        let mut matches = self.identities.iter().filter(|identity| {
            identity.result_ref == input.result_ref
                && identity.revision == input.revision
                && identity.work_id == input.work_id
                && identity.session_id == input.session_id
                && identity.scope_ref == input.scope_ref
                && identity.ledger_project_id == input.ledger_project_id
                && identity.tool_call_id == input.tool_call_id
                && identity.turn_id == input.turn_id
                && identity.result_sha256 == input.result_sha256
        });
        match (matches.next(), matches.next()) {
            (Some(found), None) => Ok(found.clone()),
            _ => Err(storage_error("operation_result_project_reference_mismatch")),
        }
    }
}

fn identity_from_child(
    child: &Value,
) -> Result<ExactProjectWorkResultIdentity, super::ProjectLedgerReadError> {
    let text = |object: &Value, key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(super::ProjectLedgerReadError::RecordShow(
                "project_work_managed_record_invalid",
            ))
    };
    let result = child
        .get("result")
        .ok_or(super::ProjectLedgerReadError::RecordShow(
            "project_work_managed_record_invalid",
        ))?;
    let scope = child
        .get("scope")
        .ok_or(super::ProjectLedgerReadError::RecordShow(
            "project_work_managed_record_invalid",
        ))?;
    Ok(ExactProjectWorkResultIdentity {
        result_ref: text(result, "resultRef")?,
        revision: result.get("sequence").and_then(Value::as_f64).ok_or(
            super::ProjectLedgerReadError::RecordShow("project_work_managed_record_invalid"),
        )?,
        work_id: text(child, "workId")?,
        session_id: text(child, "sessionId")?,
        scope_ref: text(scope, "appProjectId")?,
        ledger_project_id: text(scope, "ledgerProjectId")?,
        tool_call_id: text(result, "toolCallId")?,
        tool_name: text(result, "toolName")?,
        turn_id: text(result, "originTurnId")?,
        result_sha256: text(result, "resultSha256")?,
    })
}

fn assert_unique(identities: &[ExactProjectWorkResultIdentity]) -> Result<(), StorageError> {
    let mut seen = HashSet::new();
    for identity in identities {
        for key in [
            format!("ref\0{}", identity.result_ref),
            format!("call\0{}\0{}", identity.turn_id, identity.tool_call_id),
            format!("sequence\0{}\0{}", identity.work_id, identity.revision),
        ] {
            if !seen.insert(key) {
                return Err(storage_error("operation_result_project_identity_ambiguous"));
            }
        }
    }
    Ok(())
}

fn storage_error(code: &'static str) -> StorageError {
    StorageError {
        code,
        message: code.into(),
    }
}
fn read_error(error: ProjectLedgerReadError) -> StorageError {
    match error {
        ProjectLedgerReadError::Resolution(code)
        | ProjectLedgerReadError::RecordShow(code)
        | ProjectLedgerReadError::Owner(code)
        | ProjectLedgerReadError::DashboardInternal(code)
        | ProjectLedgerReadError::DashboardUnavailable(code) => storage_error(code),
        ProjectLedgerReadError::DashboardChanged => storage_error("project_work_snapshot_unstable"),
    }
}
