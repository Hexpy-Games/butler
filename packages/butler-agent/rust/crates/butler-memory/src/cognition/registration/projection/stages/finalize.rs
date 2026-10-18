//! Plan validation, final graph apply and vector registration of a window.

use super::*;
use crate::cognition::extraction::RunEvidence;

/// Normalizes and saves the window's plan. A fresh run (`evidence` present)
/// first saves its output and evidence as the attempt result.
pub(super) async fn validate_and_save(
    operation: &Operation,
    claim: &ClaimedProjectionWindow,
    input: &ExtractInput,
    output: &ExtractOutput,
    evidence: Option<RunEvidence>,
) -> CognitionResult<NormalizedPlan> {
    let job = claim.job_id.clone();
    let window = claim.window_ref.clone();
    let nonce = claim.owner_nonce.clone();
    let input = input.clone();
    let output = output.clone();
    let clock = operation.clock.clone();
    operation
        .write(move |state| {
            assert_current(state, &clock())?;
            if let Some(evidence) = evidence.as_ref() {
                state
                    .graph
                    .pin_binding_candidates(&window, &nonce, &input)?;
                state
                    .graph
                    .save_attempt_result(&window, &nonce, &output, evidence, &clock())?;
            }
            let plan = state.graph.normalize_plan(&input, &output)?;
            state
                .graph
                .save_validated_plan(&job, &window, &nonce, &output, &plan)?;
            Ok(plan)
        })
        .await
}

/// Applies the plan to the graph, then registers the episode's vector
/// units (a registration failure is recorded, not returned).
pub(super) async fn finish(
    operation: Operation,
    claim: Arc<ClaimedProjectionWindow>,
    input: ExtractInput,
    output: ExtractOutput,
    plan: NormalizedPlan,
    settlement_deadline: i64,
) -> CognitionResult<GraphProgress> {
    let job = claim.job_id.clone();
    let window = claim.window_ref.clone();
    let nonce = claim.owner_nonce.clone();
    let clock = operation.clock.clone();
    operation
        .write(move |state| {
            assert_current(state, &clock())?;
            state.graph.assert_candidate_sources_current(
                &state.canonical,
                &state.handle.source_root,
                &input,
                &plan,
            )?;
            state.graph.apply_final(
                ProjectionWindowOwner {
                    job_id: &job,
                    window_ref: &window,
                    nonce: &nonce,
                },
                &input,
                &output,
                &plan,
                &clock(),
            )?;
            state.graph.progress(&job)
        })
        .await?;
    let job = claim.job_id.clone();
    if let Err((error, stage)) = register_vectors(&operation, &job).await {
        mark_registration_error(&operation, &job, error, stage, settlement_deadline).await;
    }
    operation
        .read(move |state| state.graph.progress(&job))
        .await
}

async fn mark_registration_error(
    operation: &Operation,
    job: &str,
    error: CognitionError,
    stage: VectorRegistrationStage,
    deadline: i64,
) {
    if matches!(
        error.code(),
        "memory_source_changed" | "memory_generation_changed"
    ) {
        return;
    }
    let job = job.to_owned();
    let clock = operation.clock.clone();
    let settlement = operation.settlement(deadline);
    let _ = settlement
        .write(move |state| {
            assert_current(state, &clock())?;
            state
                .graph
                .mark_vector_registration_failure(&job, error.code(), stage)
        })
        .await;
}

/// Registers the vector units of the job's episode; the error and the stage
/// it failed at otherwise.
async fn register_vectors(
    operation: &Operation,
    job: &str,
) -> Result<(), (CognitionError, VectorRegistrationStage)> {
    let sources = operation
        .read({
            let job = job.to_owned();
            move |state| {
                state.graph.read_episode_projection(
                    &state.canonical,
                    &state.handle.source_root,
                    &job,
                )
            }
        })
        .await
        .map_err(|error| (error, VectorRegistrationStage::Episode))?;
    let registered = operation
        .write({
            let job = job.to_owned();
            let clock = operation.clock.clone();
            move |state| {
                assert_current(state, &clock())?;
                state.graph.register_vector_units(&job, &sources, &clock())
            }
        })
        .await
        .map_err(|error| (error, VectorRegistrationStage::Episode))?;
    match registered {
        None => Ok(()),
        Some(failure) => Err((failure.error, failure.stage)),
    }
}
