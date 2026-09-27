mod call;
mod validation;

use call::{ExtractionStageCall, call};
use validation::{aggregate_usage, bounded_evidence_schema, summarize, validate_output};

use super::{
    CognitionCandidateSearch, ExtractInput, ExtractOutput, ExtractionContractData, binding,
    meaning_prompt, meaning_to_output, source_passages, validate_meaning,
};
use crate::{cognition::CognitionResult, models::ProviderPromptPort};
use serde_json::{Value, json};
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
    pub evidence: Value,
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

pub(in crate::cognition) async fn run_extractor(
    request: ExtractionRunInput<'_>,
) -> CognitionResult<ExtractionRun> {
    let ExtractionRunInput {
        provider,
        candidates,
        mut input,
        model,
        effort,
        butler_data,
        generation,
        embedding,
        stages,
        cancellation,
        deadline,
    } = request;
    let started = Instant::now();
    let mut warnings = Vec::new();
    let passages = source_passages(&input)?;
    let prompt = meaning_prompt(&input, &passages)?;
    let data = ExtractionContractData::get();
    let meaning_schema = bounded_evidence_schema(&data.meaning_schema, passages.len());
    let (meaning, mut evidence_stages) = call(
        ExtractionStageCall {
            provider,
            stages,
            stage: "meaning",
            prompt_value: prompt,
            instructions: &data.meaning_instructions,
            schema: &meaning_schema,
            model,
            effort,
            butler_data,
            input: &input,
            cancellation: cancellation.clone(),
            repair_schema: None,
        },
        |value, _| validate_meaning(value, &passages),
    )
    .await?;
    let mut output = meaning_to_output(&input, &meaning, &passages)?;
    validate_output(&output, &input)?;
    stages.commit_meaning(&input, &output).await?;
    let base = super::CandidateSearchInput {
        source_root: std::path::Path::new(butler_data),
        generation_id: generation,
        embedding,
        cue: "",
        bound_project_id: input.bound_project_id.as_deref(),
        deadline_epoch_millis: deadline,
    };
    let (batches, loaded) = binding::prepare(&meaning, &passages, candidates, &base).await?;
    input.candidates = loaded;
    for (index, batch) in batches.iter().enumerate() {
        let stage = format!("binding{index}");
        let repair_schema = binding::repair_schema(batch);
        let (next, stage_evidence) = call(
            ExtractionStageCall {
                provider,
                stages,
                stage: &stage,
                prompt_value: batch.prompt.clone(),
                instructions: &data.binding_instructions,
                schema: &data.binding_schema,
                model,
                effort,
                butler_data,
                input: &input,
                cancellation: cancellation.clone(),
                repair_schema: Some(&repair_schema),
            },
            |value, repair| {
                let mut next = output.clone();
                let warnings = if repair == 0 {
                    binding::apply(&value, batch, &mut next, &input)?
                } else {
                    binding::apply_repair(value, batch, &mut next, &input)?
                };
                Ok((next, warnings))
            },
        )
        .await?;
        output = next.0;
        warnings.extend(next.1);
        evidence_stages.extend(stage_evidence);
    }
    summarize(&mut output);
    validate_output(&output, &input)?;
    Ok(ExtractionRun {
        output,
        evidence: json!({
            "reported_model":evidence_stages.first().and_then(|stage|stage.pointer("/provider/reported_model")).cloned().unwrap_or(Value::Null),
            "usage":aggregate_usage(&evidence_stages),
            "duration_ms":started.elapsed().as_millis(),
            "request_wire":evidence_stages.first().and_then(|stage|stage.pointer("/provider/request_wire")).cloned().unwrap_or(Value::Null),
            "stages":evidence_stages,"warnings":warnings,
        }),
        pinned_input: input,
    })
}
