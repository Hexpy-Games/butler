use super::ExtractionStagePort;
use crate::{
    cognition::{CognitionError, CognitionResult, extraction::ExtractInput},
    models::{
        PromptAdapterEntry, PromptCallbackFuture, PromptInvocationIntent, PromptJsonSchema,
        ProviderPromptError, ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest,
        ReasoningEffort,
    },
};
use serde_json::{Map, Value, json};
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
                .map_err(model_error)
        })
    }
}
impl PromptAdapterEntry for Lifecycle<'_> {
    fn entered(&self) -> Result<(), ProviderPromptError> {
        self.stages.adapter_entry().map_err(model_error)
    }
}

pub(super) struct ExtractionStageCall<'a> {
    pub provider: &'a dyn ProviderPromptPort,
    pub stages: &'a dyn ExtractionStagePort,
    pub stage: &'a str,
    pub prompt_value: Value,
    pub instructions: &'a str,
    pub schema: &'a Map<String, Value>,
    pub model: &'a str,
    pub effort: &'a str,
    pub butler_data: &'a str,
    pub input: &'a ExtractInput,
    pub cancellation: CancellationToken,
    pub repair_schema: Option<&'a Map<String, Value>>,
}

pub(super) async fn call<T, F>(
    request: ExtractionStageCall<'_>,
    mut validate: F,
) -> CognitionResult<(T, Vec<Value>)>
where
    F: FnMut(Value, usize) -> CognitionResult<T>,
{
    let ExtractionStageCall {
        provider,
        stages,
        stage,
        prompt_value,
        instructions,
        schema,
        model,
        effort,
        butler_data,
        input,
        cancellation,
        repair_schema,
    } = request;
    let mut rejection = None::<String>;
    let mut stage_evidence = Vec::new();
    for repair in 0..=MAX_STAGE_REPAIRS {
        let correction = if stage.starts_with("binding") {
            "Return a corrected complete response. For a selected candidate, put only current target evidence in current_support and exactly one selected-candidate historical evidence ID in selected_historical_support. For candidate=null, both arrays are empty. Do not invent IDs."
        } else {
            "Return a corrected complete response. Use only the provided reference IDs and evidence. Do not invent IDs."
        };
        let prompt_value = if repair == 0 {
            prompt_value.clone()
        } else {
            json!({"input": prompt_value, "correction": {"error": rejection, "instruction": correction}})
        };
        let prompt = crate::json::stringify(&prompt_value).map_err(json_error)?;
        let schema = if repair > 0 {
            repair_schema.unwrap_or(schema)
        } else {
            schema
        };
        let wire = json!({"profile":format!("memory-{stage}.v4"),"input_json_sha256":sha(&prompt),"input_json_utf8_bytes":prompt.len(),"instructions_sha256":sha(instructions),"output_schema_sha256":sha(&crate::json::stringify(&Value::Object(schema.clone())).map_err(json_error)?)});
        let request_hash = sha(&crate::json::stringify(&json!([
            input.revision,
            model,
            effort,
            wire,
            if stage == "meaning" {
                Value::Null
            } else {
                serde_json::to_value(&input.candidates).map_err(json_error)?
            }
        ]))
        .map_err(json_error)?);
        let key = if repair == 0 {
            format!("{stage}:{request_hash}")
        } else {
            format!("{stage}:{request_hash}:repair:{repair}")
        };
        let saved = stages.load(&key).await?;
        let reused = saved.is_some();
        let result = if let Some(saved) = saved {
            if saved.request_hash != request_hash {
                return Err(error("memory_extract_stage_changed"));
            }
            saved
        } else {
            let effort = parse_effort(effort)?;
            let cache = format!("memory-extract:{}:{stage}", input.revision);
            let name = format!(
                "memory_{}_v4",
                stage
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                    .collect::<String>()
            );
            let lifecycle = Lifecycle { stages, input };
            let provider_started = Instant::now();
            let result = provider
                .run_prompt(
                    ProviderPromptRequest {
                        prompt: &prompt,
                        model: Some(model),
                        reasoning_effort: Some(&effort),
                        instructions: Some(instructions),
                        response_format: Some(PromptJsonSchema {
                            name: &name,
                            schema,
                            strict: Some(true),
                        }),
                        cache_scope: Some(&cache),
                        cache_boundary: None,
                        cancellation: cancellation.clone(),
                        attachments: &[],
                        butler_data: Some(butler_data),
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
                        error("memory_extract_cancelled")
                    } else {
                        provider_error(&problem)
                    }
                })?;
            let evidence = json!({"reported_model":result.model,"usage":result.usage.as_ref().map(|u|json!({"prompt_tokens":u.prompt_tokens,"cached_tokens":u.cached_tokens,"output_tokens":u.output_tokens,"total_tokens":u.total_tokens})),"duration_ms":provider_started.elapsed().as_millis(),"request_wire":wire});
            let stage_result = crate::cognition::graph::ExtractionStageResult {
                request_hash,
                raw: result.text.clone(),
                evidence,
            };
            stages.save(&key, stage_result.clone()).await?;
            stage_result
        };
        stage_evidence.push(json!({"stage":stage,"repair":repair,"reused":reused,"request_hash":result.request_hash,"provider":result.evidence}));
        let parsed =
            serde_json::from_str(&result.raw).map_err(|_| error("memory_extract_invalid_json"));
        let validated = parsed.and_then(|value| validate(value, repair));
        match validated {
            Ok(value) => return Ok((value, stage_evidence)),
            Err(problem)
                if problem.code.starts_with("memory_extract_invalid_")
                    && repair < MAX_STAGE_REPAIRS =>
            {
                rejection = Some(problem.code.into());
            }
            Err(problem)
                if problem.code.starts_with("memory_extract_invalid_")
                    && repair == MAX_STAGE_REPAIRS =>
            {
                return Err(CognitionError::new(
                    problem.code,
                    format!("repair_exhausted: {}", problem.message),
                ));
            }
            Err(problem) => return Err(problem),
        }
    }
    Err(error("memory_extract_stage_changed"))
}

fn parse_effort(v: &str) -> CognitionResult<ReasoningEffort> {
    match v {
        "none" => Ok(ReasoningEffort::None),
        "low" => Ok(ReasoningEffort::Low),
        "medium" => Ok(ReasoningEffort::Medium),
        "high" => Ok(ReasoningEffort::High),
        "xhigh" => Ok(ReasoningEffort::Xhigh),
        "max" => Ok(ReasoningEffort::Max),
        _ => Err(error("memory_extract_invalid_reasoning_effort")),
    }
}
fn sha(v: &str) -> String {
    format!("{:x}", Sha256::digest(v.as_bytes()))
}
pub(super) fn error(c: &'static str) -> CognitionError {
    CognitionError::new(c, c)
}
pub(super) fn json_error(e: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_extract_invalid_json", e.to_string())
}
fn provider_error(e: &ProviderPromptError) -> CognitionError {
    CognitionError::new("memory_extract_provider_failed", format!("{e:?}"))
}
fn model_error(e: CognitionError) -> ProviderPromptError {
    ProviderPromptError::InvocationFailure {
        code: Some(e.code.into()),
        message: e.message,
    }
}
