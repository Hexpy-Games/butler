//! Provider stage lifecycle bound to one claimed window and its original nonce.

mod finalize;
use finalize::{finish, validate_and_save};

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use super::{Operation, ProjectionDependencies, assert_current, json_error};
use crate::cognition::{
    CognitionError, CognitionResult, GraphProgress, MemoryGenerationTarget,
    extraction::{
        CandidateSearchFuture, CandidateSearchInput, CognitionCandidateSearch,
        CognitionVectorSearch, ExtractInput, ExtractOutput, ExtractionRunInput,
        ExtractionStagePort, StageFuture, run_extractor,
    },
    graph::{
        ClaimedProjectionWindow, ExtractionStageResult, NormalizedPlan, PreviousWindowState,
        ProjectionWindowOwner, VectorHit, VectorRegistrationStage,
    },
};

struct Stages {
    operation: Operation,
    claim: Arc<ClaimedProjectionWindow>,
    adapter_entered: Arc<AtomicBool>,
}

struct Candidates {
    operation: Operation,
    vector: Arc<dyn CognitionVectorSearch>,
    input: ExtractInput,
}
impl CognitionCandidateSearch for Candidates {
    fn search<'a>(&'a self, request: CandidateSearchInput<'a>) -> CandidateSearchFuture<'a> {
        Box::pin(async move {
            let vector: Vec<VectorHit> = if request.embedding.is_some() {
                self.vector
                    .search(CandidateSearchInput {
                        source_root: request.source_root,
                        generation_id: request.generation_id,
                        embedding: request.embedding,
                        cue: request.cue,
                        bound_project_id: request.bound_project_id,
                        deadline_epoch_millis: request.deadline_epoch_millis,
                    })
                    .await
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let input = self.input.clone();
            let cue = request.cue.to_owned();
            let deadline = request.deadline_epoch_millis;
            self.operation
                .read(move |state| {
                    state.graph.source_window_candidates(
                        &state.canonical,
                        &state.handle.source_root,
                        &input,
                        &cue,
                        &vector,
                        deadline,
                    )
                })
                .await
        })
    }
}

impl ExtractionStagePort for Stages {
    fn load<'a>(&'a self, key: &'a str) -> StageFuture<'a, Option<ExtractionStageResult>> {
        Box::pin(async move {
            let window = self.claim.window_ref.clone();
            let key = key.to_owned();
            self.operation
                .read(move |state| state.graph.read_extraction_stage(&window, &key))
                .await
        })
    }
    fn save<'a>(&'a self, key: &'a str, result: ExtractionStageResult) -> StageFuture<'a, ()> {
        Box::pin(async move {
            let window = self.claim.window_ref.clone();
            let nonce = self.claim.owner_nonce.clone();
            let key = key.to_owned();
            let clock = self.operation.clock.clone();
            self.operation
                .write(move |state| {
                    assert_current(state, &clock())?;
                    state
                        .graph
                        .save_extraction_stage(&window, &nonce, &key, &result, &clock())
                })
                .await
        })
    }
    fn commit_meaning<'a>(
        &'a self,
        input: &'a ExtractInput,
        output: &'a ExtractOutput,
    ) -> StageFuture<'a, ()> {
        Box::pin(async move {
            let job = self.claim.job_id.clone();
            let window = self.claim.window_ref.clone();
            let nonce = self.claim.owner_nonce.clone();
            let input = input.clone();
            let output = output.clone();
            let clock = self.operation.clock.clone();
            self.operation
                .write(move |state| {
                    assert_current(state, &clock())?;
                    state
                        .graph
                        .commit_meaning(&job, &window, &nonce, &input, &output, &clock())
                })
                .await
        })
    }
    fn invocation_intent<'a>(&'a self, input: &'a ExtractInput) -> StageFuture<'a, ()> {
        Box::pin(async move {
            let window = self.claim.window_ref.clone();
            let nonce = self.claim.owner_nonce.clone();
            let input = input.clone();
            let clock = self.operation.clock.clone();
            self.operation
                .write(move |state| {
                    assert_current(state, &clock())?;
                    state
                        .graph
                        .pin_binding_candidates(&window, &nonce, &input)?;
                    state
                        .graph
                        .record_invocation_intent(&window, &nonce, &clock())
                })
                .await
        })
    }
    fn adapter_entry(&self) -> CognitionResult<()> {
        self.adapter_entered.store(true, Ordering::Release);
        Ok(())
    }
}

pub(super) async fn execute(
    operation: Operation,
    claim: Arc<ClaimedProjectionWindow>,
    input: ExtractInput,
    deps: &ProjectionDependencies,
    adapter_entered: Arc<AtomicBool>,
) -> CognitionResult<GraphProgress> {
    let stages = Stages {
        operation: operation.clone(),
        claim: claim.clone(),
        adapter_entered,
    };
    let (output, plan) =
        if claim.previous_state == PreviousWindowState::Planned || claim.output.is_some() {
            let value = claim.output.clone().ok_or_else(|| {
                CognitionError::new(
                    "memory_projection_plan_missing",
                    "memory_projection_plan_missing",
                )
            })?;
            let output: ExtractOutput = serde_json::from_value(value).map_err(json_error)?;
            let plan = if let Some(saved) = &claim.plan {
                serde_json::from_value(saved.clone()).map_err(json_error)?
            } else {
                validate_and_save(&operation, &claim, &input, &output, None).await?
            };
            (output, plan)
        } else {
            let (source_root, embedding, generation, target) = operation
                .read(|state| {
                    Ok((
                        state.handle.source_root.to_string_lossy().into_owned(),
                        state.handle.embedding.clone(),
                        state.handle.generation_id.clone(),
                        state.input.target.clone(),
                    ))
                })
                .await?;
            let deadline = deps.host.now_epoch_millis().saturating_add(5_000);
            let provider_cancel = operation.shutdown.child_token();
            let caller = operation.cancellation.clone();
            let signal = provider_cancel.clone();
            let bridge = tokio::spawn(async move {
                if let Some(caller) = caller {
                    caller.cancelled().await;
                    signal.cancel();
                }
            });
            let candidates = Candidates {
                operation: operation.clone(),
                vector: deps.candidates.clone(),
                input: input.clone(),
            };
            let timeout = if matches!(target, MemoryGenerationTarget::Rebuild { .. })
                && matches!(claim.model.as_str(), "zai/glm-5.3" | "zai-api/glm-5.3")
            {
                600_000
            } else {
                180_000
            };
            let run = tokio::time::timeout(
                Duration::from_millis(timeout),
                run_extractor(ExtractionRunInput {
                    provider: deps.provider.as_ref(),
                    candidates: &candidates,
                    input: input.clone(),
                    model: &claim.model,
                    effort: &claim.reasoning_effort,
                    butler_data: &source_root,
                    generation: &generation,
                    embedding: embedding.as_ref(),
                    stages: &stages,
                    cancellation: provider_cancel.clone(),
                    deadline,
                }),
            )
            .await;
            bridge.abort();
            let run = match run {
                Ok(Ok(result)) => result,
                Ok(Err(_problem)) if provider_cancel.is_cancelled() => {
                    return Err(CognitionError::new(
                        "memory_extract_cancelled",
                        "memory_extract_cancelled",
                    ));
                }
                Ok(Err(problem)) => return Err(problem),
                Err(_) => {
                    provider_cancel.cancel();
                    return Err(CognitionError::new(
                        "memory_extract_timeout",
                        "memory_extract_timeout",
                    ));
                }
            };
            let plan = validate_and_save(
                &operation,
                &claim,
                &run.pinned_input,
                &run.output,
                Some(run.evidence),
            )
            .await?;
            return finish(
                operation,
                claim,
                run.pinned_input,
                run.output,
                plan,
                deps.host.now_epoch_millis().saturating_add(5_000),
            )
            .await;
        };
    finish(
        operation,
        claim,
        input,
        output,
        plan,
        deps.host.now_epoch_millis().saturating_add(5_000),
    )
    .await
}
