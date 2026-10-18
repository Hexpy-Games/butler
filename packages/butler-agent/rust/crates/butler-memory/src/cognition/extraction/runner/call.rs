//! One extraction stage call with bounded repairs. Each attempt is keyed by a
//! hash of its request, saved before validation and replayed when the same
//! request is made again (after a crash or on retry).

use super::ExtractionStagePort;
use super::evidence::{ProviderEvidence, RequestWire, StageEvidence, StageUsage};
use crate::cognition::extraction::ExtractInput;
use crate::cognition::graph::ExtractionStageResult;
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use butler_models::models::{
    PromptAdapterEntry, PromptCallbackFuture, PromptInvocationIntent, PromptJsonSchema,
    ProviderPromptError, ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest,
    ReasoningEffort,
};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

const MAX_STAGE_REPAIRS: usize = 2;

struct Lifecycle<'a> {
    stages: &'a dyn ExtractionStagePort,
    input: &'a ExtractInput,
}
impl PromptInvocationIntent for Lifecycle<'_> {
    fn invoked(&self) -> PromptCallbackFuture<'_> {
        Box::pin(async move {
            self.stages
                .invocation_intent(self.input)
                .await
                .map_err(|error| model_error(&error))
        })
    }
}
impl PromptAdapterEntry for Lifecycle<'_> {
    fn entered(&self) -> Result<(), ProviderPromptError> {
        self.stages
            .adapter_entry()
            .map_err(|error| model_error(&error))
    }
}

pub(super) struct ExtractionStageCall<'a, P> {
    pub provider: &'a dyn ProviderPromptPort,
    pub stages: &'a dyn ExtractionStagePort,
    pub stage: &'a str,
    pub prompt: &'a P,
    pub instructions: &'a str,
    /// Passthrough: JSON Schema sent to the provider as the structured-output
    /// contract.
    pub schema: &'a Map<String, Value>,
    pub model: &'a str,
    pub effort: &'a str,
    pub butler_data: &'a str,
    pub input: &'a ExtractInput,
    pub cancellation: CancellationToken,
    /// Passthrough: the narrower JSON Schema of repair calls.
    pub repair_schema: Option<&'a Map<String, Value>>,
}

/// A repair call's prompt: the first input plus why its answer was rejected.
#[derive(Serialize)]
struct RepairPrompt<'a, P> {
    input: &'a P,
    correction: Correction<'a>,
}
#[derive(Serialize)]
struct Correction<'a> {
    error: Option<&'a str>,
    instruction: &'static str,
}

/// The replay identity of one attempt.
struct AttemptKey {
    prompt: String,
    wire: RequestWire,
    request_hash: String,
    key: String,
}

/// Calls the stage until `validate` accepts the model's JSON, repairing up to
/// [`MAX_STAGE_REPAIRS`] times when it rejects with an
/// `memory_extract_invalid_*` code. Returns the accepted value and the
/// evidence of every attempt.
pub(super) async fn call<T, P, F>(
    request: ExtractionStageCall<'_, P>,
    mut validate: F,
) -> CognitionResult<(T, Vec<StageEvidence>)>
where
    P: Serialize,
    F: FnMut(Value, usize) -> CognitionResult<T>,
{
    let mut rejection = None::<String>;
    let mut stage_evidence = Vec::new();
    for repair in 0..=MAX_STAGE_REPAIRS {
        let attempt = attempt_key(&request, repair, rejection.as_deref())?;
        let saved = request.stages.load(&attempt.key).await?;
        let reused = saved.is_some();
        let result = if let Some(saved) = saved {
            if saved.request_hash != attempt.request_hash {
                return Err(error(CognitionCode::MemoryExtractStageChanged));
            }
            saved
        } else {
            let result = invoke(&request, repair, &attempt).await?;
            request.stages.save(&attempt.key, result.clone()).await?;
            result
        };
        stage_evidence.push(StageEvidence {
            stage: request.stage.to_owned(),
            repair,
            reused,
            request_hash: result.request_hash,
            provider: result.evidence,
        });
        let validated = serde_json::from_str(&result.raw)
            .map_err(|source| error(CognitionCode::MemoryExtractInvalidJson).with_source(source))
            .and_then(|value| validate(value, repair));
        match validated {
            Ok(value) => return Ok((value, stage_evidence)),
            Err(problem) if !problem.code().starts_with("memory_extract_invalid_") => {
                return Err(problem);
            }
            Err(problem) if repair == MAX_STAGE_REPAIRS => {
                let message = format!("repair_exhausted: {}", problem.message());
                return Err(problem.with_message(message));
            }
            Err(problem) => rejection = Some(problem.code().into()),
        }
    }
    Err(error(CognitionCode::MemoryExtractStageChanged))
}

/// The prompt text of attempt `repair` and the hash that keys its saved
/// result: revision, model, effort, wire digests and (for binding stages)
/// the offered candidates.
fn attempt_key<P: Serialize>(
    request: &ExtractionStageCall<'_, P>,
    repair: usize,
    rejection: Option<&str>,
) -> CognitionResult<AttemptKey> {
    let stage = request.stage;
    let prompt = if repair == 0 {
        crate::js_json::stringify(request.prompt)
    } else {
        crate::js_json::stringify(&RepairPrompt {
            input: request.prompt,
            correction: Correction {
                error: rejection,
                instruction: correction_instruction(stage),
            },
        })
    }
    .map_err(json_error)?;
    let schema = schema(request, repair);
    let wire = RequestWire {
        profile: format!("memory-{stage}.v4"),
        input_json_sha256: sha(&prompt),
        input_json_utf8_bytes: prompt.len(),
        instructions_sha256: sha(request.instructions),
        output_schema_sha256: sha(&crate::js_json::stringify(schema).map_err(json_error)?),
    };
    let candidates = if stage == "meaning" {
        None
    } else {
        Some(&request.input.candidates)
    };
    let request_hash = sha(&crate::js_json::stringify(&(
        &request.input.revision,
        request.model,
        request.effort,
        &wire,
        candidates,
    ))
    .map_err(json_error)?);
    let key = if repair == 0 {
        format!("{stage}:{request_hash}")
    } else {
        format!("{stage}:{request_hash}:repair:{repair}")
    };
    Ok(AttemptKey {
        prompt,
        wire,
        request_hash,
        key,
    })
}

fn correction_instruction(stage: &str) -> &'static str {
    if stage.starts_with("binding") {
        "Return a corrected complete response. For a selected candidate, put only current target evidence in current_support and exactly one selected-candidate historical evidence ID in selected_historical_support. For candidate=null, both arrays are empty. Do not invent IDs."
    } else {
        "Return a corrected complete response. Use only the provided reference IDs and evidence. Do not invent IDs."
    }
}

fn schema<'a, P>(request: &ExtractionStageCall<'a, P>, repair: usize) -> &'a Map<String, Value> {
    if repair > 0 {
        request.repair_schema.unwrap_or(request.schema)
    } else {
        request.schema
    }
}

/// Calls the provider once (strict JSON schema, no provider retries) and
/// records what it reported.
async fn invoke<P>(
    request: &ExtractionStageCall<'_, P>,
    repair: usize,
    attempt: &AttemptKey,
) -> CognitionResult<ExtractionStageResult> {
    let stage = request.stage;
    let effort = parse_effort(request.effort)?;
    let cache = format!("memory-extract:{}:{stage}", request.input.revision);
    let name = format!(
        "memory_{}_v4",
        stage
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect::<String>()
    );
    let lifecycle = Lifecycle {
        stages: request.stages,
        input: request.input,
    };
    let cancellation = &request.cancellation;
    let provider_started = Instant::now();
    let result = request
        .provider
        .run_prompt(
            ProviderPromptRequest {
                prompt: &attempt.prompt,
                model: Some(request.model),
                reasoning_effort: Some(&effort),
                instructions: Some(request.instructions),
                response_format: Some(PromptJsonSchema {
                    name: &name,
                    schema: schema(request, repair),
                    strict: Some(true),
                }),
                cache_scope: Some(&cache),
                cache_boundary: None,
                cancellation: cancellation.clone(),
                attachments: &[],
                butler_data: Some(request.butler_data),
                usage_attribution: None,
                stream_observer: None,
                provider_retry_attempts: Some(0.0),
            },
            ProviderPromptLifecycle {
                invocation_intent: Some(&lifecycle),
                adapter_entry: Some(&lifecycle),
            },
        )
        .await
        .map_err(|problem| {
            if cancellation.is_cancelled() {
                error(CognitionCode::MemoryExtractCancelled).with_source(problem)
            } else {
                provider_error(problem)
            }
        })?;
    Ok(ExtractionStageResult {
        request_hash: attempt.request_hash.clone(),
        raw: result.text,
        evidence: ProviderEvidence {
            reported_model: result.model,
            usage: result.usage.map(|u| StageUsage {
                prompt_tokens: u.prompt_tokens,
                cached_tokens: u.cached_tokens,
                output_tokens: u.output_tokens,
                total_tokens: u.total_tokens,
            }),
            duration_ms: u64::try_from(provider_started.elapsed().as_millis()).unwrap_or(u64::MAX),
            request_wire: attempt.wire.clone(),
        },
    })
}

fn parse_effort(v: &str) -> CognitionResult<ReasoningEffort> {
    match v {
        "none" => Ok(ReasoningEffort::None),
        "low" => Ok(ReasoningEffort::Low),
        "medium" => Ok(ReasoningEffort::Medium),
        "high" => Ok(ReasoningEffort::High),
        "xhigh" => Ok(ReasoningEffort::Xhigh),
        "max" => Ok(ReasoningEffort::Max),
        _ => Err(error(CognitionCode::MemoryExtractInvalidReasoningEffort)),
    }
}
fn sha(v: &str) -> String {
    format!("{:x}", Sha256::digest(v.as_bytes()))
}
pub(super) fn error(c: CognitionCode) -> CognitionError {
    CognitionError::new(c, c.as_str())
}
pub(super) fn json_error(e: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryExtractInvalidJson, e.to_string()).with_source(e)
}
fn provider_error(e: ProviderPromptError) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryExtractProviderFailed, format!("{e:?}")).with_source(e)
}
/// Invocation callbacks report Cognition failures as provider invocation
/// failures, which carry only a code and message.
fn model_error(e: &CognitionError) -> ProviderPromptError {
    ProviderPromptError::InvocationFailure {
        code: Some(e.code().into()),
        message: e.message(),
    }
}
