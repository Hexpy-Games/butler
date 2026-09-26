//! Existing-generation graph connection and durable registration repository.

mod apply;
mod cache_quantum;
mod readiness;
pub(in crate::cognition) use readiness::{CacheReadinessRow, StageReadiness, VectorReadinessRow};
mod candidates;
mod consolidate;
mod failure;
pub(in crate::cognition) mod index;
mod input;
mod internal_supersession;
mod invalidation;
mod jobs;
mod operator_repair;
mod plan;
mod progress_adapters;
mod projection;
mod recall;
mod recall_index;
mod registration;
mod retry_failed;
mod schema;
mod stages;
mod typed_lifecycle;
mod typed_registration;
pub(in crate::cognition) use typed_lifecycle::TypedLifecycleInput;
mod vector_optimize;
mod vector_quantum;
mod vector_registration;
mod vector_representative;

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use super::{CognitionError, CognitionResult};

pub(in crate::cognition) use cache_quantum::ClaimedCacheJob;
pub(in crate::cognition) use candidates::VectorHit;
pub(in crate::cognition) use consolidate::GraphConsolidateMetrics;
pub(in crate::cognition) use internal_supersession::InternalSupersessionInput;
pub(crate) use jobs::GraphProgress;
pub(in crate::cognition) use jobs::{CatchupCursors, PendingSemanticJob};
pub(in crate::cognition) use operator_repair::CandidateInputRepairRequest;
pub(crate) use operator_repair::ProjectionModelPolicyInput;
pub(in crate::cognition) use plan::NormalizedPlan;
pub(in crate::cognition) use projection::{
    ClaimProjectionWindowInput, ClaimedProjectionWindow, PreviousWindowState,
};
pub(in crate::cognition) use recall::{
    CurrentVectorMatches, GraphRecallReader, ProjectionCoverage, RawSourceSelection,
    RecallEpisodeRow, RecallMention, RelationshipState, TemporalSelection,
};
pub(super) use registration::{GraphRegistration, RegistrationInput};
pub(in crate::cognition) use retry_failed::{RetryFailedCounts, VectorRepairRequest};
pub(in crate::cognition) use stages::ExtractionStageResult;
pub(super) use typed_registration::TypedRegistrationInput;
pub(in crate::cognition) use vector_quantum::ClaimedVectorUnit;
pub(in crate::cognition) use vector_registration::{
    EpisodeProjectionSource, VectorRegistrationFailure, VectorRegistrationStage,
};

#[derive(Clone, Copy)]
pub(in crate::cognition) struct ProjectionWindowOwner<'a> {
    pub job_id: &'a str,
    pub window_ref: &'a str,
    pub nonce: &'a str,
}

pub(super) struct GraphRepository {
    connection: Option<Connection>,
}

impl GraphRepository {
    pub(in crate::cognition) fn retry_failed(
        &mut self,
        generation_id: &str,
        now: &str,
    ) -> CognitionResult<RetryFailedCounts> {
        retry_failed::retry_failed(self.connection_mut()?, generation_id, now)
    }

    pub(in crate::cognition) fn repair_selected_invalid_vectors(
        &mut self,
        generation_id: &str,
        embedding_version: &str,
        request: &VectorRepairRequest,
    ) -> CognitionResult<usize> {
        retry_failed::repair_selected_invalid_vectors(
            self.connection_mut()?,
            generation_id,
            embedding_version,
            request,
        )
    }

    pub(in crate::cognition) fn consolidate(
        &mut self,
        now_ms: i64,
        decay_d: f64,
    ) -> CognitionResult<GraphConsolidateMetrics> {
        consolidate::run(self.connection_mut()?, now_ms, decay_d)
    }
    pub(in crate::cognition) fn removable_vector_keys(&self) -> CognitionResult<Vec<String>> {
        vector_optimize::removable_keys(self.connection()?)
    }
    pub(in crate::cognition) fn pending_semantic_job(
        &self,
        now: &str,
    ) -> CognitionResult<Option<PendingSemanticJob>> {
        jobs::pending_semantic(self.connection()?, now)
    }
    pub(in crate::cognition) fn recover_interrupted_semantic(
        &mut self,
        input: ClaimProjectionWindowInput<'_>,
    ) -> CognitionResult<()> {
        let tx = self.connection_mut()?.transaction().map_err(db_error)?;
        projection::recover_interrupted(&tx, &input)?;
        tx.commit().map_err(db_error)
    }
    pub(in crate::cognition) fn create_fresh(path: &Path, now: &str) -> CognitionResult<()> {
        let mut connection = Connection::open(path).map_err(db_error)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(db_error)?;
        schema::ensure(&mut connection, now)?;
        connection.close().map_err(|(_, error)| db_error(error))
    }
    pub(in crate::cognition) fn read_episode_projection(
        &self,
        canonical: &crate::conversation::ConversationSourceReader,
        source_root: &Path,
        job: &str,
    ) -> CognitionResult<Vec<EpisodeProjectionSource>> {
        vector_registration::read_episode_projection(
            self.connection()?,
            canonical,
            source_root,
            job,
        )
    }
    pub(in crate::cognition) fn register_vector_units(
        &mut self,
        job: &str,
        sources: &[EpisodeProjectionSource],
        now: &str,
    ) -> CognitionResult<Option<VectorRegistrationFailure>> {
        Ok(vector_registration::refresh_vector_units_for_job(
            self.connection_mut()?,
            job,
            sources,
            now,
        )
        .err())
    }
    pub(in crate::cognition) fn mark_vector_registration_failure(
        &mut self,
        job: &str,
        code: &str,
        stage: VectorRegistrationStage,
    ) -> CognitionResult<()> {
        vector_registration::mark_vector_registration_failure(self.connection()?, job, code, stage)
    }
    pub(in crate::cognition) fn pinned_extract_input(
        &self,
        window: &str,
        nonce: &str,
    ) -> CognitionResult<crate::cognition::extraction::ExtractInput> {
        failure::pinned_input(self.connection()?, window, nonce)
    }
    pub(in crate::cognition) fn expand_context(
        &self,
        canonical: &crate::conversation::ConversationSourceReader,
        source_root: &Path,
        input: &crate::cognition::extraction::ExtractInput,
    ) -> CognitionResult<crate::cognition::extraction::ExtractInput> {
        input::expand(self.connection()?, canonical, source_root, input)
    }
    pub(in crate::cognition) fn record_window_disposition(
        &mut self,
        owner: ProjectionWindowOwner<'_>,
        disposition: &str,
        revised: Option<&crate::cognition::extraction::ExtractInput>,
        now: &str,
        provider_invoked: bool,
    ) -> CognitionResult<()> {
        failure::disposition(
            self.connection_mut()?,
            owner,
            disposition,
            revised,
            now,
            provider_invoked,
        )
    }
    pub(in crate::cognition) fn source_window_candidates(
        &self,
        canonical: &crate::conversation::ConversationSourceReader,
        source_root: &Path,
        input: &crate::cognition::extraction::ExtractInput,
        cue: &str,
        vector: &[VectorHit],
        deadline: i64,
    ) -> CognitionResult<Vec<crate::cognition::extraction::ExtractCandidate>> {
        candidates::load(
            self.connection()?,
            canonical,
            source_root,
            input,
            cue,
            vector,
            deadline,
        )
    }
    pub(in crate::cognition) fn assert_candidate_sources_current(
        &self,
        canonical: &crate::conversation::ConversationSourceReader,
        source_root: &Path,
        input: &crate::cognition::extraction::ExtractInput,
        plan: &NormalizedPlan,
    ) -> CognitionResult<()> {
        candidates::assert_current(self.connection()?, canonical, source_root, input, plan)
    }
    pub(in crate::cognition) fn settle_window_failure(
        &mut self,
        owner: ProjectionWindowOwner<'_>,
        code: &str,
        now: &str,
        provider_invoked: bool,
        repair_exhausted: bool,
    ) -> CognitionResult<()> {
        failure::settle(
            self.connection_mut()?,
            owner,
            code,
            now,
            provider_invoked,
            repair_exhausted,
        )
    }
    pub(in crate::cognition) fn commit_meaning(
        &mut self,
        job: &str,
        window: &str,
        nonce: &str,
        input: &crate::cognition::extraction::ExtractInput,
        output: &crate::cognition::extraction::ExtractOutput,
        now: &str,
    ) -> CognitionResult<()> {
        apply::commit_meaning(
            self.connection_mut()?,
            job,
            window,
            nonce,
            input,
            output,
            now,
        )
    }

    pub(in crate::cognition) fn apply_final(
        &mut self,
        owner: ProjectionWindowOwner<'_>,
        input: &crate::cognition::extraction::ExtractInput,
        output: &crate::cognition::extraction::ExtractOutput,
        plan: &NormalizedPlan,
        now: &str,
    ) -> CognitionResult<()> {
        apply::apply_final(self.connection_mut()?, owner, input, output, plan, now)
    }
    pub(in crate::cognition) fn normalize_plan(
        &self,
        input: &crate::cognition::extraction::ExtractInput,
        output: &crate::cognition::extraction::ExtractOutput,
    ) -> CognitionResult<NormalizedPlan> {
        plan::normalize(self.connection()?, input, output)
    }
    pub(in crate::cognition) fn build_extract_input(
        &self,
        canonical: &crate::conversation::ConversationSourceReader,
        source_root: &Path,
        job_id: &str,
        window_ref: &str,
        source_refs: &[String],
    ) -> CognitionResult<crate::cognition::extraction::ExtractInput> {
        input::build(
            self.connection()?,
            canonical,
            source_root,
            job_id,
            window_ref,
            source_refs,
        )
    }
    pub(super) fn open(path: &Path) -> CognitionResult<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(db_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(db_error)?;
        connection
            .busy_timeout(Duration::from_millis(5_000))
            .map_err(db_error)?;
        Ok(Self {
            connection: Some(connection),
        })
    }

    pub(in crate::cognition) fn open_readonly(path: &Path) -> CognitionResult<Self> {
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(db_error)?;
        connection
            .busy_timeout(Duration::from_millis(5_000))
            .map_err(db_error)?;
        Ok(Self {
            connection: Some(connection),
        })
    }

    pub(super) fn ensure_schema(&mut self, now: &str) -> CognitionResult<()> {
        schema::ensure(self.connection_mut()?, now)
    }

    pub(super) fn replay(
        &mut self,
        canonical: &crate::conversation::ConversationSourceReader,
        notice: super::ConversationSourceNotice<'_>,
        episode_id: &str,
        revision: &str,
        completion_id: Option<&str>,
        now: &str,
    ) -> CognitionResult<Option<String>> {
        jobs::replay(
            self.connection_mut()?,
            canonical,
            notice,
            episode_id,
            revision,
            completion_id,
            now,
        )
    }

    pub(super) fn register(
        &mut self,
        input: RegistrationInput<'_>,
    ) -> CognitionResult<GraphRegistration> {
        registration::register(self.connection_mut()?, input)
    }

    pub(super) fn progress(&self, job_id: &str) -> CognitionResult<GraphProgress> {
        jobs::progress(self.connection()?, job_id)
    }

    pub(in crate::cognition) fn job_revision(&self, job: &str) -> CognitionResult<String> {
        self.connection()?
            .query_row(
                "SELECT revision FROM memory_projection_jobs WHERE job_id=?1",
                [job],
                |row| row.get(0),
            )
            .map_err(db_error)
    }

    pub(in crate::cognition) fn claim_projection_window(
        &mut self,
        input: ClaimProjectionWindowInput<'_>,
    ) -> CognitionResult<Option<ClaimedProjectionWindow>> {
        projection::claim(self.connection_mut()?, input)
    }

    pub(in crate::cognition) fn pin_projection_input(
        &self,
        window_ref: &str,
        owner_nonce: &str,
        input: &serde_json::Value,
        migration_note: Option<&str>,
    ) -> CognitionResult<()> {
        projection::pin_input(
            self.connection()?,
            window_ref,
            owner_nonce,
            input,
            migration_note,
        )
    }

    pub(in crate::cognition) fn pin_binding_candidates(
        &self,
        window: &str,
        nonce: &str,
        input: &crate::cognition::extraction::ExtractInput,
    ) -> CognitionResult<()> {
        stages::pin_binding_candidates(self.connection()?, window, nonce, input)
    }

    pub(in crate::cognition) fn read_extraction_stage(
        &self,
        window: &str,
        key: &str,
    ) -> CognitionResult<Option<ExtractionStageResult>> {
        stages::read(self.connection()?, window, key)
    }
    pub(in crate::cognition) fn record_invocation_intent(
        &self,
        window: &str,
        nonce: &str,
        now: &str,
    ) -> CognitionResult<()> {
        stages::invocation_intent(self.connection()?, window, nonce, now)
    }
    pub(in crate::cognition) fn save_extraction_stage(
        &mut self,
        window: &str,
        nonce: &str,
        key: &str,
        result: &ExtractionStageResult,
        now: &str,
    ) -> CognitionResult<()> {
        stages::save(self.connection_mut()?, window, nonce, key, result, now)
    }
    pub(in crate::cognition) fn save_attempt_result(
        &mut self,
        window: &str,
        nonce: &str,
        output: &serde_json::Value,
        evidence: &serde_json::Value,
        now: &str,
    ) -> CognitionResult<()> {
        stages::save_result(self.connection_mut()?, window, nonce, output, evidence, now)
    }
    pub(in crate::cognition) fn save_validated_plan(
        &self,
        job: &str,
        window: &str,
        nonce: &str,
        output: &serde_json::Value,
        plan: &serde_json::Value,
    ) -> CognitionResult<()> {
        stages::save_plan(self.connection()?, job, window, nonce, output, plan)
    }

    pub(super) fn close(mut self) -> CognitionResult<()> {
        let Some(connection) = self.connection.take() else {
            return Ok(());
        };
        connection.close().map_err(|(_, error)| db_error(error))
    }

    fn connection(&self) -> CognitionResult<&Connection> {
        self.connection
            .as_ref()
            .ok_or_else(|| CognitionError::new("memory_graph_closed", "memory_graph_closed"))
    }

    fn connection_mut(&mut self) -> CognitionResult<&mut Connection> {
        self.connection
            .as_mut()
            .ok_or_else(|| CognitionError::new("memory_graph_closed", "memory_graph_closed"))
    }
}

impl Drop for GraphRepository {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            let _ = connection.close();
        }
    }
}

pub(super) fn db_error(error: rusqlite::Error) -> CognitionError {
    CognitionError::new("memory_graph_unavailable", error.to_string())
}
