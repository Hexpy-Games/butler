use std::sync::Arc;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::btcc::{
    BtccError, LegacyImport, ProjectWorkLegacyInput, ProjectWorkLegacyObserveInput,
    ProjectWorkLegacySnapshot, ProjectWorkMaterialInput, ProjectWorkOperationIdentity,
    ProjectWorkOperationKind, WorkTurnScope, WorkView,
};

use super::super::publication::ProjectLedgerRecordKind;
use super::codec;
use super::{ProjectWorkRepository, invalid};

impl ProjectWorkRepository {
    pub(super) async fn import_legacy_impl(
        &self,
        scope: WorkTurnScope,
    ) -> Result<Option<LegacyImport>, BtccError> {
        self.assert_scope(&scope)?;
        let input = ProjectWorkLegacyInput {
            scope: scope.clone(),
            resolved_scope: self.scope.clone(),
        };
        if let Some(observed) = self
            .shared
            .legacy
            .read_import_observation(input.clone())
            .await?
        {
            let source_identity = if observed.source_program_id.starts_with("current-r3:") {
                format!("current-r3:{}", observed.work_id)
            } else {
                format!("r2:{}:{}", observed.source_program_id, observed.work_id)
            };
            let identity = self.legacy_identity(&source_identity, &observed.source_sha256)?;
            let receipt = self.publish(identity, || async { Ok(None) }, false).await?;
            if receipt.skipped
                || !receipt.targets.iter().any(|target| {
                    target.id == observed.work_id
                        && target.kind == ProjectLedgerRecordKind::Work
                        && target.parent_id.is_none()
                })
            {
                return Err(invalid("project_work_occurrence_receipt_missing"));
            }
            let current = self.require_current(&observed.work_id).await?;
            return Ok(Some(LegacyImport {
                source_program_id: observed.source_program_id,
                imported: false,
                work: current.view,
            }));
        }
        let Some(snapshot) = self
            .shared
            .legacy
            .capture_stable_snapshot(input.clone())
            .await?
        else {
            return Ok(None);
        };
        let identity = self.legacy_identity(&snapshot.source_identity, &snapshot.source_sha256)?;
        self.verify_legacy_results(&snapshot, None).await?;
        let material = self
            .shared
            .projection
            .capture_work_material(ProjectWorkMaterialInput {
                candidate: snapshot.work.clone(),
            })
            .await?;
        codec::assert_material(&snapshot.work, &material)?;
        let repo = self.clone();
        let prepare_identity = identity.clone();
        let prepared_snapshot = Arc::clone(&snapshot);
        let prepared_material = material.clone();
        let observe_scope = scope.clone();
        let publish = self.publish(identity, move || async move {
            let relation = repo.relation(&scope).await?;
            if relation.head.is_some() || relation.binding.is_some() || repo.read_current(&prepared_snapshot.work.work_id).await?.is_some() {
                return Err(invalid("project_work_legacy_target_conflict"));
            }
            let children = legacy_children(&repo, &prepared_snapshot, &prepare_identity)?;
            let revisions = legacy_revisions(&prepared_snapshot);
            let refs = prepared_snapshot.bindings.iter().map(|binding| json!({
                "bindingRevisionId":binding.binding_revision_id,"turnId":binding.turn_id,"revision":binding.revision,
            })).collect::<Vec<_>>();
            let manifest = codec::manifest_for_view(codec::ManifestViewInput {
                prior: None,
                view: &prepared_snapshot.work,
                scope: &repo.scope,
                identity: &prepare_identity,
                binding_refs: Value::Array(refs),
                session_head: true,
                material: &prepared_material,
                revisions: &revisions,
            })?;
            let mut updates = vec![codec::work_update(&manifest, true, &repo.shared.ledger.collation)?];
            for child in children {
                let (id, kind, title) = super::write::child_metadata(&child)?;
                if let Some(update) = repo.child_update(&prepared_snapshot.work.work_id, &id, kind, title, child).await? {
                    updates.push(update);
                }
            }
            Ok(Some(updates))
        }, false).await?;
        if publish.skipped {
            return Err(invalid("project_work_legacy_publication_missing"));
        }
        let current = self.require_current(&snapshot.work.work_id).await?;
        self.verify_legacy_results(&snapshot, Some(&current.view))
            .await?;
        self.shared
            .legacy
            .revalidate_before_observation(input, Arc::clone(&snapshot))
            .await?;
        let project_root = self.scope.ledger_root.clone();
        let head = self
            .shared
            .ledger
            .run(move |_, collation| {
                super::super::source_head::observe(&project_root, collation)
                    .map(|head| head.source_sha256)
            })
            .await
            .map_err(super::snapshot::read_error)?;
        self.shared
            .legacy
            .observe_imported(ProjectWorkLegacyObserveInput {
                scope: observe_scope,
                resolved_scope: self.scope.clone(),
                snapshot: Arc::clone(&snapshot),
                canonical_head_sha256: head,
                canonical_result_refs: current.view.result_refs.clone(),
            })
            .await?;
        Ok(Some(LegacyImport {
            source_program_id: snapshot.source_program_id.clone(),
            imported: !publish.replayed,
            work: current.view,
        }))
    }

    fn legacy_identity(
        &self,
        source_identity: &str,
        source_sha256: &str,
    ) -> Result<ProjectWorkOperationIdentity, BtccError> {
        let payload = format!(
            "btcc-project-work-legacy-import.v1\0{}\0{source_identity}\0{source_sha256}",
            self.scope.ledger_project_id
        );
        Ok(ProjectWorkOperationIdentity {
            kind: ProjectWorkOperationKind::LegacyImport,
            id: format!("{:x}", Sha256::digest(payload.as_bytes())),
            request_sha256: codec::request_digest(
                &json!({
                    "ledgerProjectId":self.scope.ledger_project_id,"sourceIdentity":source_identity,"sourceSha256":source_sha256,
                }),
                &self.shared.ledger.collation,
            )?,
            mutation_call_id: None,
        })
    }

    async fn verify_legacy_results(
        &self,
        snapshot: &ProjectWorkLegacySnapshot,
        canonical: Option<&WorkView>,
    ) -> Result<(), BtccError> {
        if canonical.is_some_and(|view| view.result_refs != snapshot.work.result_refs) {
            return Err(invalid("project_work_legacy_result_reference_mismatch"));
        }
        for result in &snapshot.work.result_refs {
            let evidence = self
                .shared
                .results
                .read_committed_result(crate::btcc::ProjectWorkCommittedResultInput {
                    turn_id: result.origin_turn_id.clone(),
                    session_id: snapshot.work.session_id.clone(),
                    tool_call_id: result.tool_call_id.clone(),
                })
                .await?;
            if result.result_ref != codec::record_id("result", &result.tool_call_id)
                || evidence.tool_name != result.tool_name
                || result.result_sha256.as_deref() != Some(evidence.result_sha256.as_str())
            {
                return Err(invalid("project_work_legacy_result_invalid"));
            }
        }
        Ok(())
    }
}

fn legacy_revisions(snapshot: &ProjectWorkLegacySnapshot) -> Value {
    json!({
        "planRevision":snapshot.plans.last().map(|item| item.revision).unwrap_or(0),
        "checkpointRevision":snapshot.checkpoints.last().map(|item| item.checkpoint.revision).unwrap_or(0),
        "checkpointResultSequence":snapshot.checkpoints.last().map(|item| item.to_result_sequence).unwrap_or(0),
        "reviewRevision":snapshot.reviews.last().map(|item| item.revision).unwrap_or(0),
        "dispositionRevision":snapshot.dispositions.last().map(|item| item.disposition.revision).unwrap_or(0),
    })
}

fn legacy_children(
    repo: &ProjectWorkRepository,
    snapshot: &ProjectWorkLegacySnapshot,
    identity: &ProjectWorkOperationIdentity,
) -> Result<Vec<Value>, BtccError> {
    let work = &snapshot.work;
    let mut children = Vec::new();
    for plan in &snapshot.plans {
        children.push(
            json!({"schema":"butler.btcc-project-work-plan.v1","workId":work.work_id,
            "operationIdentity":codec::identity_value(identity),"plan":plan}),
        );
    }
    for item in &snapshot.checkpoints {
        children.push(json!({"schema":"butler.btcc-project-work-checkpoint.v1","workId":work.work_id,
            "operationIdentity":codec::identity_value(identity),"checkpointIdentity":item.checkpoint.checkpoint_revision_id,
            "resultWindow":{"fromSequence":item.from_result_sequence,"toSequence":item.to_result_sequence},
            "checkpoint":item.checkpoint}));
    }
    for review in &snapshot.reviews {
        children.push(
            json!({"schema":"butler.btcc-project-work-review.v1","workId":work.work_id,
            "operationIdentity":codec::identity_value(identity),"review":review,
            "boundResultSequence":review.bound_result_refs.len()}),
        );
    }
    for item in &snapshot.dispositions {
        let material = crate::btcc::build_project_work_material_snapshot(
            &item.historical_view,
            item.disposition.material_fingerprint.clone(),
            Some(item.effect_watermark.clone()),
            Vec::new(),
        )?;
        children.push(
            json!({"schema":"butler.btcc-project-work-disposition.v1","workId":work.work_id,
            "operationIdentity":codec::identity_value(identity),"disposition":item.disposition,
            "materialSnapshot":material}),
        );
    }
    for (index, result) in work.result_refs.iter().enumerate() {
        let mut item = serde_json::to_value(result)
            .map_err(|_| invalid("project_work_legacy_result_invalid"))?;
        item["sequence"] = Value::from(index + 1);
        children.push(json!({"schema":"butler.btcc-project-work-result-reference.v1","workId":work.work_id,
            "sessionId":work.session_id,"scope":{"appProjectId":repo.scope.app_project_id,"ledgerProjectId":repo.scope.ledger_project_id},
            "operationIdentity":codec::identity_value(identity),"result":item}));
    }
    for binding in &snapshot.bindings {
        children.push(json!({"schema":"butler.btcc-project-work-binding.v1","workId":work.work_id,
            "operationIdentity":codec::identity_value(identity),
            "binding":{"bindingRevisionId":binding.binding_revision_id,"turnId":binding.turn_id,
                "sessionId":work.session_id,"revision":binding.revision,"boundAt":binding.bound_at}}));
    }
    Ok(children)
}
