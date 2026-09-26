use serde_json::json;
use sha2::{Digest, Sha256};

use super::super::contracts::{
    ProjectLedgerRecordKind, ProjectLedgerRecordOperation, ProjectLedgerRecordUpdate,
    ProjectWorkPublicationError,
};
use crate::locale::LocaleCollation;

pub(super) fn updates(
    updates: &[ProjectLedgerRecordUpdate],
    collation: &LocaleCollation,
) -> Result<Vec<ProjectLedgerRecordUpdate>, ProjectWorkPublicationError> {
    let mut proofs = Vec::with_capacity(updates.len());
    for update in updates {
        let kind = update.kind.as_ref().ok_or_else(invalid)?;
        let title = update
            .title
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(invalid)?;
        let status = update
            .status
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(invalid)?;
        let spec = update
            .spec
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(invalid)?;
        let body = update.body.as_deref().ok_or_else(invalid)?;
        if update.id.starts_with("btcc-project-work-proof-") {
            return Err(invalid());
        }
        let record = json!({
            "id": update.id,
            "kind": kind.as_str(),
            "parentId": update.parent_id,
            "title": title,
            "status": status,
            "spec": spec,
            "schema": format!("project-ledger.{}.v1", kind.as_str()),
            "body": body,
        });
        let value = json!({
            "schema": "butler.btcc-project-work-publication-proof.v1",
            "record": record,
        });
        let canonical = crate::project_ledger::work_json::canonical(&value, collation)
            .map_err(|_| invalid())?;
        let id = format!(
            "btcc-project-work-proof-{:x}",
            Sha256::digest(canonical.as_bytes())
        );
        let mut proof = ProjectLedgerRecordUpdate::new(id);
        proof.operation = Some(ProjectLedgerRecordOperation::Create);
        proof.kind = Some(ProjectLedgerRecordKind::Reference);
        proof.title = Some("Project Work publication proof target".into());
        proof.status = Some("active".into());
        proofs.push(proof);
    }
    Ok(proofs)
}

fn invalid() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::Adapter("project_work_publication_proof_invalid")
}
