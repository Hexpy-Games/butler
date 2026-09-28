//! The extractor run: a meaning call over the window's passages, then one
//! binding call per batch of targets, each with replayable repairs.

mod call;
mod evidence;
mod validation;

use call::{ExtractionStageCall, call};
pub(in crate::cognition) use evidence::{ProviderEvidence, RunEvidence};
use validation::{bounded_evidence_schema, summarize, validate_output};

use super::{
    CognitionCandidateSearch, ExtractInput, ExtractOutput, ExtractionContractData, binding,
    meaning_prompt, meaning_to_output, source_passages, validate_meaning,
};
use crate::cognition::CognitionResult;
use butler_models::models::ProviderPromptPort;
use serde_json::{Map, Value};
use std::{future::Future, pin::Pin, time::Instant};
use tokio_util::sync::CancellationToken;

pub(in crate::cognition) type StageFuture<'a, T> =
    Pin<Box<dyn Future<Output = CognitionResult<T>> + Send + 'a>>;
pub(in crate::cognition) trait ExtractionStagePort: Send + Sync {
    fn load<'a>(
        &'a self,
        key: &'a str,
    ) -> StageFuture<'a, Option<crate::cognition::graph::ExtractionStageResult>>;
    fn save<'a>(
        &'a self,
        key: &'a str,
        result: crate::cognition::graph::ExtractionStageResult,
    ) -> StageFuture<'a, ()>;
    fn commit_meaning<'a>(
        &'a self,
        input: &'a ExtractInput,
        output: &'a ExtractOutput,
    ) -> StageFuture<'a, ()>;
    fn invocation_intent<'a>(&'a self, input: &'a ExtractInput) -> StageFuture<'a, ()>;
    fn adapter_entry(&self) -> CognitionResult<()>;
}
pub(in crate::cognition) struct ExtractionRun {
    pub output: ExtractOutput,
    pub evidence: RunEvidence,
    pub pinned_input: ExtractInput,
}

pub(in crate::cognition) struct ExtractionRunInput<'a> {
    pub provider: &'a dyn ProviderPromptPort,
    pub candidates: &'a dyn CognitionCandidateSearch,
    pub input: ExtractInput,
    pub model: &'a str,
    pub effort: &'a str,
    pub butler_data: &'a str,
    pub generation: &'a str,
    pub embedding: Option<&'a crate::cognition::GenerationEmbedding>,
    pub stages: &'a dyn ExtractionStagePort,
    pub cancellation: CancellationToken,
    pub deadline: i64,
}

/// Runs meaning then binding for one window. The meaning result is committed
/// before binding starts; the pinned input gains the loaded candidates.
pub(in crate::cognition) async fn run_extractor(
    request: ExtractionRunInput<'_>,
) -> CognitionResult<ExtractionRun> {
    let started = Instant::now();
    let passages = source_passages(&request.input)?;
    let prompt = meaning_prompt(&request.input, &passages)?;
    let data = ExtractionContractData::get();
    let meaning_schema = bounded_evidence_schema(&data.meaning_schema, passages.len());
    let (meaning, mut stages) = call(
        stage_call(&request, "meaning", &prompt, &meaning_schema, None),
        |value, _| validate_meaning(value, &passages),
    )
    .await?;
    let mut output = meaning_to_output(&request.input, &meaning, &passages)?;
    validate_output(&output, &request.input)?;
    request
        .stages
        .commit_meaning(&request.input, &output)
        .await?;
    let base = super::CandidateSearchInput {
        source_root: std::path::Path::new(request.butler_data),
        generation_id: request.generation,
        embedding: request.embedding,
        cue: "",
        bound_project_id: request.input.bound_project_id.as_deref(),
        deadline_epoch_millis: request.deadline,
    };
    let (batches, loaded) =
        binding::prepare(&meaning, &passages, request.candidates, &base).await?;
    let mut input = request.input.clone();
    input.candidates = loaded;
    let request = ExtractionRunInput { input, ..request };
    let mut warnings = Vec::new();
    for (index, batch) in batches.iter().enumerate() {
        let stage = format!("binding{index}");
        let repair_schema = binding::repair_schema(batch);
        let (next, stage_evidence) = call(
            stage_call(
                &request,
                &stage,
                &batch.prompt,
                &data.binding_schema,
                Some(&repair_schema),
            ),
            |value, repair| {
                let mut next = output.clone();
                let warnings = if repair == 0 {
                    binding::apply(&value, batch, &mut next, &request.input)?
                } else {
                    binding::apply_repair(value, batch, &mut next, &request.input)?
                };
                Ok((next, warnings))
            },
        )
        .await?;
        output = next.0;
        warnings.extend(next.1);
        stages.extend(stage_evidence);
    }
    summarize(&mut output);
    validate_output(&output, &request.input)?;
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    Ok(ExtractionRun {
        output,
        evidence: RunEvidence::new(stages, warnings, duration_ms),
        pinned_input: request.input,
    })
}

/// The call of `stage` for this run. Passthrough: `schema` and
/// `repair_schema` are JSON Schema documents for the provider.
fn stage_call<'a, P>(
    request: &'a ExtractionRunInput<'_>,
    stage: &'a str,
    prompt: &'a P,
    // Passthrough: JSON Schema for the provider.
    schema: &'a Map<String, Value>,
    // Passthrough: JSON Schema for the provider's repair calls.
    repair_schema: Option<&'a Map<String, Value>>,
) -> ExtractionStageCall<'a, P> {
    ExtractionStageCall {
        provider: request.provider,
        stages: request.stages,
        stage,
        prompt,
        instructions: if stage == "meaning" {
            &ExtractionContractData::get().meaning_instructions
        } else {
            &ExtractionContractData::get().binding_instructions
        },
        schema,
        model: request.model,
        effort: request.effort,
        butler_data: request.butler_data,
        input: &request.input,
        cancellation: request.cancellation.clone(),
        repair_schema,
    }
}
