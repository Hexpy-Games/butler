use super::*;

pub(super) async fn validate_and_save(
    operation: &Operation,
    claim: &ClaimedProjectionWindow,
    input: &ExtractInput,
    output: &ExtractOutput,
    // Present when the attempt result must be saved with its evidence.
    evidence: Option<serde_json::Value>,
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
                state.graph.save_attempt_result(
                    &window,
                    &nonce,
                    &serde_json::to_value(&output).map_err(json_error)?,
                    evidence,
                    &clock(),
                )?;
            }
            let plan = state.graph.normalize_plan(&input, &output)?;
            state.graph.save_validated_plan(
                &job,
                &window,
                &nonce,
                &serde_json::to_value(&output).map_err(json_error)?,
                &serde_json::to_value(&plan).map_err(json_error)?,
            )?;
            Ok(plan)
        })
        .await
}

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
    let sources = operation
        .read({
            let job = job.clone();
            move |state| {
                state.graph.read_episode_projection(
                    &state.canonical,
                    &state.handle.source_root,
                    &job,
                )
            }
        })
        .await;
    match sources {
        Ok(sources) => {
            let registered = operation
                .write({
                    let job = job.clone();
                    let clock = operation.clock.clone();
                    move |state| {
                        assert_current(state, &clock())?;
                        state.graph.register_vector_units(&job, &sources, &clock())
                    }
                })
                .await;
            match registered {
                Ok(None) => {}
                Ok(Some(failure)) => {
                    mark_registration_error(
                        &operation,
                        &job,
                        failure.error,
                        failure.stage,
                        settlement_deadline,
                    )
                    .await;
                }
                Err(error) => {
                    mark_registration_error(
                        &operation,
                        &job,
                        error,
                        VectorRegistrationStage::Episode,
                        settlement_deadline,
                    )
                    .await;
                }
            }
        }
        Err(error) => {
            mark_registration_error(
                &operation,
                &job,
                error,
                VectorRegistrationStage::Episode,
                settlement_deadline,
            )
            .await;
        }
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
        error.code,
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
                .mark_vector_registration_failure(&job, error.code, stage)
        })
        .await;
}
