use super::*;
mod recovery;
use crate::btcc::{
    BtccError,
    storage::{BtccStorage, WorkModelRepository},
};
use serde_json::{Value, json};
use std::sync::Arc;

/// Composition sequences immutable Ledger publication before SQLite activation.
/// All SQL and blocking file work use their existing owner lanes.
pub struct WorkModelService {
    pub(super) repository: WorkModelRepository,
    publication: Arc<dyn SpecPublication>,
    pub(super) changed: Arc<tokio::sync::Notify>,
}

impl WorkModelService {
    pub async fn open(
        storage: BtccStorage,
        publication: Arc<dyn SpecPublication>,
        enabled: bool,
    ) -> Result<Option<Arc<Self>>, BtccError> {
        let changed = storage.work_model_changes();
        let repository = WorkModelRepository::new(storage);
        if enabled && !repository.enabled().await? {
            check(
                publication.empty_installation().await?,
                "work_model_requires_empty_installation",
            )?;
        }
        if !repository.enable(enabled).await? {
            return Ok(None);
        }
        let service = Arc::new(Self {
            repository,
            publication,
            changed,
        });
        service.recover().await?;
        Ok(Some(service))
    }

    pub async fn apply(
        &self,
        session: String,
        request: WorkModelRequest,
    ) -> Result<Value, BtccError> {
        let hash = fingerprint(&request)?;
        let admission = self
            .repository
            .admit(session.clone(), request.clone(), hash.clone())
            .await?;
        if let Some(receipt) = admission.receipt {
            return Ok(receipt);
        }
        let prepared = self.prepare(&session, &request).await;
        let receipt = self
            .repository
            .commit(session, request, hash, prepared)
            .await?;
        if receipt.get("ok") == Some(&json!(true)) {
            self.changed.notify_one();
        }
        Ok(receipt)
    }

    async fn prepare(
        &self,
        session: &str,
        request: &WorkModelRequest,
    ) -> Result<Option<Creation>, BtccError> {
        if matches!(
            request.command,
            WorkModelCommand::CreateLight { .. }
                | WorkModelCommand::Create { .. }
                | WorkModelCommand::Activate { .. }
                | WorkModelCommand::Publish { .. }
        ) {
            self.repository
                .creation_gate(
                    session.into(),
                    matches!(request.command, WorkModelCommand::Publish { .. }),
                )
                .await?;
        }
        match &request.command {
            WorkModelCommand::CreateLight {
                goal,
                done_criteria,
                tasks,
            } => {
                let bundle = light_bundle(session, request, goal, done_criteria, tasks)?;
                self.publish_bundle(session, request, bundle)
                    .await
                    .map(Some)
            }
            WorkModelCommand::Create { bundle } => self
                .publish_bundle(session, request, bundle.clone())
                .await
                .map(Some),
            WorkModelCommand::Activate {
                tier,
                goal,
                root_node_id,
                published_refs,
                works,
                tasks,
            } => {
                check(!published_refs.is_empty(), "spec_required")?;
                let verified = self.verify(session, published_refs).await?;
                let bundle = InitialBundle {
                    tier: *tier,
                    goal: goal.clone(),
                    root_node_id: root_node_id.clone(),
                    nodes: verified.iter().map(|s| s.node.clone()).collect(),
                    works: works.clone(),
                    tasks: tasks.clone(),
                };
                validate_bundle(&bundle)?;
                Ok(Some(Creation { bundle, verified }))
            }
            WorkModelCommand::Publish { nodes } => self
                .publish_inactive(session, request, nodes)
                .await
                .map(Some),
            _ => {
                let refs = self
                    .repository
                    .operation_specs(session.into(), request.command.clone())
                    .await?;
                self.verify(session, &refs).await?;
                Ok(None)
            }
        }
    }

    async fn publish_inactive(
        &self,
        session: &str,
        request: &WorkModelRequest,
        nodes: &[SpecDraft],
    ) -> Result<Creation, BtccError> {
        // Publication is inactive. Activation performs full tree/graph validation.
        check(!nodes.is_empty(), "spec_required")?;
        let refs = self
            .publication
            .publish(
                session.into(),
                request.instruction_id.clone(),
                request.idempotency_key.clone(),
                nodes.to_vec(),
            )
            .await?;
        let verified = self.verify(session, &refs).await?;
        Ok(Creation {
            bundle: InitialBundle {
                tier: 0,
                goal: String::new(),
                root_node_id: String::new(),
                nodes: nodes.to_vec(),
                works: vec![],
                tasks: vec![],
            },
            verified,
        })
    }

    async fn publish_bundle(
        &self,
        session: &str,
        request: &WorkModelRequest,
        bundle: InitialBundle,
    ) -> Result<Creation, BtccError> {
        validate_bundle(&bundle)?;
        let refs = self
            .publication
            .publish(
                session.into(),
                request.instruction_id.clone(),
                request.idempotency_key.clone(),
                bundle.nodes.clone(),
            )
            .await?;
        let verified = self.verify(session, &refs).await?;
        check(
            verified.len() == bundle.nodes.len(),
            "spec_publication_incomplete",
        )?;
        Ok(Creation { bundle, verified })
    }

    pub(super) async fn verify(
        &self,
        session: &str,
        refs: &[SpecRef],
    ) -> Result<Vec<VerifiedSpec>, BtccError> {
        let scope = self.repository.scope(session.into()).await?;
        let mut verified = Vec::with_capacity(refs.len());
        for reference in refs {
            let value = self
                .publication
                .resolve(scope.clone(), reference.clone())
                .await?;
            check(
                value.reference == *reference
                    && value.node.node_id == reference.node_id
                    && value.node.node_revision == reference.node_revision,
                "spec_integrity_error",
            )?;
            verified.push(value);
        }
        Ok(verified)
    }

    pub async fn summary(
        &self,
        session: String,
        cursor: Option<String>,
    ) -> Result<Value, BtccError> {
        self.repository.summary(session, cursor).await
    }

    /// Read without touching SQLite, for idle-budget observation.
    pub fn operation_count(&self) -> u64 {
        self.repository.operation_count()
    }

    pub fn changed(&self) -> Arc<tokio::sync::Notify> {
        self.changed.clone()
    }

    pub async fn outbox(&self, after: u64) -> Result<Value, BtccError> {
        self.repository.outbox(after).await
    }

    pub async fn graph(&self, session: String, cursor: Option<String>) -> Result<Value, BtccError> {
        self.repository.graph(session, cursor).await
    }

    pub async fn graph_plan(&self, id: String, cursor: Option<String>) -> Result<Value, BtccError> {
        self.repository.graph_plan(id, cursor).await
    }

    pub async fn read_spec(&self, session: String, node: String) -> Result<Value, BtccError> {
        let refs = self.repository.ancestors(session.clone(), node).await?;
        Ok(json!({"nodes": self.verify(&session, &refs).await?}))
    }

    /// Runtime enforces the tier floor before a legacy or nested child assignment.
    pub async fn delegation_gate(&self, session: String) -> Result<(), BtccError> {
        self.repository.delegation_gate(session).await
    }

    pub async fn effect_grant(
        &self,
        session: String,
        turn: String,
    ) -> Result<WorkModelEffectGrant, BtccError> {
        self.effect_gate(session.clone()).await?;
        let mut grant = self.repository.effect_grant(session, turn).await?;
        grant.publication = Some(self.publication.clone());
        Ok(grant)
    }

    pub async fn effect_gate(&self, session: String) -> Result<(), BtccError> {
        let refs = self.repository.effect_specs(session.clone()).await?;
        self.verify(&session, &refs).await?;
        Ok(())
    }

    pub async fn delegation_task(&self, session: String) -> Result<TaskCard, BtccError> {
        self.effect_gate(session.clone()).await?;
        self.repository.delegation_task(session).await
    }

    pub async fn child_result(&self, session: String) -> Result<Vec<String>, BtccError> {
        self.repository.child_result(session).await
    }
}

fn light_bundle(
    session: &str,
    request: &WorkModelRequest,
    goal: &str,
    criteria: &[Criterion],
    tasks: &[TaskDraft],
) -> Result<InitialBundle, BtccError> {
    let node_id = stable_id(
        "SPEC",
        session,
        &format!("{}:{}", request.instruction_id, request.idempotency_key),
    )?;
    let node = SpecDraft {
        node_id: node_id.clone(),
        node_revision: 1,
        parent_id: None,
        concern_id: node_id.clone(),
        responsibility: goal.into(),
        kind: SpecKind::Brief,
        parts: vec![SpecPart {
            id: "GOAL".into(),
            behaviour: goal.into(),
            design: String::new(),
            implementation: String::new(),
        }],
        criteria: criteria.to_vec(),
        child_coverage: vec![],
        source_refs: vec![request.instruction_id.clone()],
        decision_refs: vec![],
        research_method: None,
        independent_review: false,
    };
    let tasks = tasks
        .iter()
        .map(|task| TaskDraft {
            work_key: "light".into(),
            node_id: node_id.clone(),
            part_ids: vec!["GOAL".into()],
            ..task.clone()
        })
        .collect();
    Ok(InitialBundle {
        tier: 1,
        goal: goal.into(),
        root_node_id: node_id.clone(),
        nodes: vec![node],
        works: vec![WorkDraft {
            key: "light".into(),
            node_id,
            outcome: goal.into(),
            part_ids: vec!["GOAL".into()],
            criterion_ids: criteria.iter().map(|c| c.id.clone()).collect(),
        }],
        tasks,
    })
}
