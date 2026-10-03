//! Runtime-issued identity bridge to the existing effect journal, without legacy Work rows/reviews.
use crate::btcc::{DurableWorkStatus as WorkStatus, WorkOrigin, WorkPlan, WorkScope, WorkView};

pub struct WorkModelEffectGrant {
    pub(crate) scope_id: String,
    pub(crate) revision_id: String,
    pub(crate) session: String,
    pub(crate) turn: String,
    pub(crate) objective: String,
    pub(crate) repository: crate::btcc::storage::WorkModelRepository,
    pub(crate) publication: Option<std::sync::Arc<dyn super::SpecPublication>>,
}
impl WorkModelEffectGrant {
    pub(crate) async fn validate(&self) -> Result<(), crate::btcc::BtccError> {
        let current = self
            .repository
            .effect_grant(self.session.clone(), self.turn.clone())
            .await?;
        super::check(
            current.scope_id == self.scope_id && current.revision_id == self.revision_id,
            "work_model_effect_fenced",
        )?;
        let refs = self.repository.effect_specs(self.session.clone()).await?;
        if let Some(publication) = &self.publication {
            let scope = self.repository.scope(self.session.clone()).await?;
            for reference in refs {
                publication.resolve(scope.clone(), reference).await?;
            }
        }
        Ok(())
    }
    pub fn scope_id(&self) -> &str {
        &self.scope_id
    }
    pub fn revision_id(&self) -> &str {
        &self.revision_id
    }
    /// Compatibility metadata for file replay/Allow identity; no accepted legacy review is invented.
    pub fn effect_metadata(&self) -> WorkView {
        WorkView {
            work_id: self.scope_id.clone(),
            session_id: self.session.clone(),
            scope: WorkScope::Session {
                session_id: self.session.clone(),
            },
            origin: WorkOrigin {
                turn_id: self.turn.clone(),
                message_id: self.turn.clone(),
            },
            objective: self.objective.clone(),
            status: WorkStatus::Open,
            current_stage: None,
            allowed_next_stages: vec![],
            action_progress: vec![],
            current_plan: Some(WorkPlan {
                plan_revision_id: self.revision_id.clone(),
                revision: 1,
                objective: self.objective.clone(),
                governing_refs: vec![],
                execution_mode: None,
                actions: vec![],
                checks: vec![],
                origin_turn_id: self.turn.clone(),
                created_at: String::new(),
            }),
            latest_checkpoint: None,
            latest_plan_review: None,
            latest_result_review: None,
            latest_completion_validation: None,
            latest_disposition: None,
            effect_watermark: None,
            effect_blockers: None,
            result_refs: vec![],
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}
