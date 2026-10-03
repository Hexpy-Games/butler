//! Immutable Spec revisions on the Ledger's sparse publication/recovery lane.
use super::publication::{ProjectLedgerRecordKind, ProjectLedgerRecordOperation};
use super::{ProjectLedger, ProjectLedgerRecordUpdate, RecordSections, committed, records};
use butler_turn::btcc::work_model::{
    SpecDraft, SpecPublication, SpecRef, VerifiedSpec, fingerprint, stable_id,
};
use butler_turn::btcc::{
    BtccError, PortFuture, ProjectWorkOperationIdentity, ProjectWorkOperationKind,
    ResolvedProjectWorkScope,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    schema: String,
    scope_id: String,
    authoring_instruction_id: String,
    node: SpecDraft,
}

impl SpecPublication for ProjectLedger {
    fn empty_installation(&self) -> PortFuture<'_, bool> {
        Box::pin(async move {
            self.run(|root, _| empty_ledger(&root.join("project-ledger/projects")))
                .await
                .map_err(|source| failure("work_model_preflight_failed").with_source(source))
        })
    }
    fn publish(
        &self,
        scope: String,
        instruction: String,
        key: String,
        nodes: Vec<SpecDraft>,
    ) -> PortFuture<'_, Vec<SpecRef>> {
        Box::pin(async move {
            let ledger_scope = scope_for(&self.data_root, &scope)?;
            self.ensure_project_ledger(ledger_scope.clone(), "Session Specs".into())
                .await
                .map_err(|source| failure("spec_publication_failed").with_source(source))?;
            let mut updates = Vec::with_capacity(nodes.len());
            let mut references = Vec::with_capacity(nodes.len());
            for node in nodes {
                let document = Document {
                    schema: "butler.work-model.spec.v1".into(),
                    scope_id: scope.clone(),
                    authoring_instruction_id: instruction.clone(),
                    node,
                };
                let id = format!(
                    "{}-R{}",
                    stable_id("SPEC-WM", &scope, &document.node.node_id)?,
                    document.node.node_revision
                );
                let body = serde_json::to_string(&document)
                    .map_err(|source| failure("spec_encoding_failed").with_source(source))?;
                let reference = SpecRef {
                    node_id: document.node.node_id.clone(),
                    node_revision: document.node.node_revision,
                    ledger_revision_id: id.clone(),
                    content_hash: body_hash(body.as_bytes()),
                };
                let mut update = ProjectLedgerRecordUpdate::new(id);
                update.operation = Some(ProjectLedgerRecordOperation::Create);
                update.kind = Some(ProjectLedgerRecordKind::Spec);
                update.title = Some(document.node.responsibility);
                update.status = Some("published".into());
                update.body = Some(body);
                update.sections = RecordSections {
                    spec: Some(reference.node_id.clone()),
                    ..RecordSections::default()
                };
                updates.push(update);
                references.push(reference);
            }
            let identity = ProjectWorkOperationIdentity {
                kind: ProjectWorkOperationKind::MutationCall,
                id: stable_id("SPEC-PUBLISH", &scope, &format!("{instruction}:{key}"))?,
                request_sha256: fingerprint(&updates)?,
                mutation_call_id: Some(key),
            };
            self.publish_work_records(ledger_scope, identity, move || async { Ok(Some(updates)) })
                .await
                .map_err(|source| failure("spec_publication_failed").with_source(source))?;
            Ok(references)
        })
    }

    fn locate(
        &self,
        scope: String,
        instruction: String,
        node: String,
        revision: u64,
    ) -> PortFuture<'_, Option<VerifiedSpec>> {
        Box::pin(async move {
            let id = format!("{}-R{revision}", stable_id("SPEC-WM", &scope, &node)?);
            let ledger_scope = scope_for(&self.data_root, &scope)?;
            self.run(move |_, _| {
                locate_revision(
                    &ledger_scope.ledger_root,
                    &scope,
                    &instruction,
                    node,
                    revision,
                    id,
                )
            })
            .await
            .map_err(|e| failure("spec_integrity_error").with_source(e))
        })
    }

    fn resolve(&self, scope: String, reference: SpecRef) -> PortFuture<'_, VerifiedSpec> {
        Box::pin(async move {
            let expected = format!(
                "{}-R{}",
                stable_id("SPEC-WM", &scope, &reference.node_id)?,
                reference.node_revision
            );
            if expected != reference.ledger_revision_id {
                return Err(failure("spec_scope_invalid"));
            }
            let ledger_scope = scope_for(&self.data_root, &scope)?;
            self.run(move |_, _| resolve_revision(&ledger_scope.ledger_root, &scope, reference))
                .await
                .map_err(|source| {
                    let code = match &source {
                        super::ProjectLedgerReadError::RecordShow { code, .. } => *code,
                        _ => "spec_integrity_error",
                    };
                    failure(code).with_source(source)
                })
        })
    }
}

fn scope_for(root: &std::path::Path, scope: &str) -> Result<ResolvedProjectWorkScope, BtccError> {
    let id = stable_id("wm-session", scope, "ledger")?;
    Ok(ResolvedProjectWorkScope {
        app_project_id: scope.into(),
        ledger_project_id: id.clone(),
        ledger_root: root.join("project-ledger/projects").join(id),
    })
}

fn body_hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn failure(code: &str) -> BtccError {
    BtccError::relayed(code.to_owned(), code)
}

type ReadResult<T> = Result<T, super::ProjectLedgerReadError>;
fn read_error(code: &'static str) -> super::ProjectLedgerReadError {
    super::ProjectLedgerReadError::record_show(code)
}
fn empty_ledger(projects: &std::path::Path) -> ReadResult<bool> {
    let entries = match std::fs::read_dir(projects) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(source) => return Err(read_error("work_model_preflight_failed").with_source(source)),
    };
    for entry in entries {
        let entry = entry
            .map_err(|source| read_error("work_model_preflight_failed").with_source(source))?;
        for kind in ["specs", "work", "tasks", "plans"] {
            if directory_has_records(&entry.path().join(kind))? {
                return Ok(false);
            }
        }
    }
    Ok(true)
}
fn selected_document(root: &std::path::Path, id: &str) -> ReadResult<Option<(Document, String)>> {
    let Some(raw) = committed::read_selected(root, &format!("specs/{}.md", id.to_lowercase()))?
    else {
        return Ok(None);
    };
    let body = records::frontmatter_body_ref(&raw).trim();
    let document: Document = serde_json::from_str(body)
        .map_err(|source| read_error("spec_integrity_error").with_source(source))?;
    Ok(Some((document, body_hash(body.as_bytes()))))
}
fn verify_document(document: &Document, scope: &str, node: &str, revision: u64) -> ReadResult<()> {
    if document.schema != "butler.work-model.spec.v1"
        || document.scope_id != scope
        || document.node.node_id != node
        || document.node.node_revision != revision
    {
        return Err(read_error("spec_integrity_error"));
    }
    Ok(())
}
fn locate_revision(
    root: &std::path::Path,
    scope: &str,
    instruction: &str,
    node: String,
    revision: u64,
    id: String,
) -> ReadResult<Option<VerifiedSpec>> {
    let Some((document, content_hash)) = selected_document(root, &id)? else {
        return Ok(None);
    };
    verify_document(&document, scope, &node, revision)?;
    if document.authoring_instruction_id != instruction {
        return Err(read_error("spec_integrity_error"));
    }
    Ok(Some(VerifiedSpec {
        reference: SpecRef {
            node_id: node,
            node_revision: revision,
            ledger_revision_id: id,
            content_hash,
        },
        node: document.node,
    }))
}
fn resolve_revision(
    root: &std::path::Path,
    scope: &str,
    reference: SpecRef,
) -> ReadResult<VerifiedSpec> {
    let (document, hash) = selected_document(root, &reference.ledger_revision_id)?
        .ok_or_else(|| read_error("spec_unpublished"))?;
    verify_document(
        &document,
        scope,
        &reference.node_id,
        reference.node_revision,
    )?;
    if hash != reference.content_hash {
        return Err(read_error("spec_integrity_error"));
    }
    Ok(VerifiedSpec {
        reference,
        node: document.node,
    })
}

fn directory_has_records(path: &std::path::Path) -> ReadResult<bool> {
    match std::fs::read_dir(path) {
        Ok(records) => Ok(records.into_iter().next().is_some()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(read_error("work_model_preflight_failed").with_source(source)),
    }
}

pub(crate) fn owns_scope(root: &std::path::Path) -> bool {
    root.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("wm-session-"))
        .is_some_and(|id| id.len() == 24 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}
pub(crate) fn immutable_record(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(records::frontmatter_body_ref(raw).trim())
        .ok()
        .and_then(|value| {
            value
                .get("schema")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .as_deref()
        == Some("butler.work-model.spec.v1")
}
