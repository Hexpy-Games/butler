mod artifact;
mod contracts;
mod prompt;
#[cfg(test)]
mod tests;
mod usage;
mod write;

use std::{path::PathBuf, sync::Arc};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::{
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
    models::{ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest, ReasoningEffort},
};

pub(crate) use contracts::{
    BriefingGenerationError, BriefingInputFuture, BriefingInputSnapshot, BriefingInputSource,
    BriefingPersona, BriefingProjectSignal, BriefingSettings,
};
use contracts::{error, prepared_fingerprint};
use usage::Usage;

struct BriefingRunContext<'a> {
    input: &'a BriefingInputSnapshot,
    project: Option<&'a BriefingProjectSignal>,
    run_id: &'a str,
    now: DateTime<Utc>,
    local_minute: u16,
    model: &'a str,
    reasoning: ReasoningEffort,
    cancellation: &'a CancellationToken,
}

struct BriefingMetrics {
    outcome: &'static str,
    reason: Option<&'static str>,
    generated: u64,
    failed: u64,
    skipped: u64,
    general: Option<String>,
    projects: Vec<String>,
    model: Option<String>,
    reasoning: Option<ReasoningEffort>,
    usage: Usage,
}

pub(crate) struct BriefingGenerationService {
    data_root: PathBuf,
    coordinator: Arc<CognitionWriteCoordinator>,
    provider: Arc<dyn ProviderPromptPort>,
    source: Arc<dyn BriefingInputSource>,
}

impl BriefingGenerationService {
    pub(crate) fn new(
        data_root: PathBuf,
        coordinator: Arc<CognitionWriteCoordinator>,
        provider: Arc<dyn ProviderPromptPort>,
        source: Arc<dyn BriefingInputSource>,
    ) -> Self {
        Self {
            data_root,
            coordinator,
            provider,
            source,
        }
    }

    pub(crate) async fn generate(
        &self,
        run_id: &str,
        now: DateTime<Utc>,
        cancellation: &CancellationToken,
    ) -> Result<Map<String, Value>, BriefingGenerationError> {
        ensure_active(cancellation)?;
        let input = self.source.snapshot().await?;
        let (model, reasoning) = match &input.settings {
            BriefingSettings::Configured {
                model,
                reasoning_effort,
                ..
            } => (model.clone(), *reasoning_effort),
            BriefingSettings::Unavailable { reason, .. } => {
                return Ok(metrics(&BriefingMetrics {
                    outcome: "configuration_unavailable",
                    reason: Some(reason),
                    generated: 0,
                    failed: 0,
                    skipped: 0,
                    general: None,
                    projects: vec![],
                    model: None,
                    reasoning: None,
                    usage: Usage::default(),
                }));
            }
        };
        let local_minute = self.source.local_minute(now.timestamp_millis())?;
        let mut usage = Usage::default();
        let mut generated = 0;
        let mut failed = 0;
        let mut skipped = 0;
        let mut general = None;
        let mut project_paths = Vec::new();
        match self
            .run_one(
                BriefingRunContext {
                    input: &input,
                    project: None,
                    run_id,
                    now,
                    local_minute,
                    model: &model,
                    reasoning,
                    cancellation,
                },
                &mut usage,
            )
            .await
        {
            Ok(path) => {
                general = Some(path);
                generated += 1;
            }
            Err(error) if error.code == "new_chat_briefing_cancelled" => return Err(error),
            Err(_) => failed += 1,
        }
        for project in &input.projects {
            ensure_active(cancellation)?;
            if project.recent_session_titles.is_empty() && project.ledger_event_summary.is_empty() {
                skipped += 1;
                continue;
            }
            match self
                .run_one(
                    BriefingRunContext {
                        input: &input,
                        project: Some(project),
                        run_id,
                        now,
                        local_minute,
                        model: &model,
                        reasoning,
                        cancellation,
                    },
                    &mut usage,
                )
                .await
            {
                Ok(path) => {
                    project_paths.push(path);
                    generated += 1;
                }
                Err(error) if error.code == "new_chat_briefing_cancelled" => return Err(error),
                Err(_) => failed += 1,
            }
        }
        Ok(metrics(&BriefingMetrics {
            outcome: "completed",
            reason: None,
            generated,
            failed,
            skipped,
            general,
            projects: project_paths,
            model: Some(model),
            reasoning: Some(reasoning),
            usage,
        }))
    }

    async fn run_one(
        &self,
        context: BriefingRunContext<'_>,
        usage: &mut Usage,
    ) -> Result<String, BriefingGenerationError> {
        let BriefingRunContext {
            input,
            project,
            run_id,
            now,
            local_minute,
            model,
            reasoning,
            cancellation,
        } = context;
        ensure_active(cancellation)?;
        let prompt = prompt::prompt(input, project, now, local_minute, run_id);
        let instructions = prompt::instructions(
            prompt::locale(input),
            input
                .persona
                .text
                .as_deref()
                .is_some_and(|text| !text.is_empty()),
        );
        let scope = if project.is_some() {
            "project"
        } else {
            "general"
        };
        let cache_scope = format!(
            "cognition:{run_id}:new_chat_briefing:{scope}{}",
            project
                .map(|project| format!(":{}", write::safe_segment(&project.id)))
                .unwrap_or_default()
        );
        let root = self.data_root.to_string_lossy().into_owned();
        let response = self
            .provider
            .run_prompt(
                ProviderPromptRequest {
                    prompt: &prompt,
                    model: Some(model),
                    reasoning_effort: Some(&reasoning),
                    instructions: Some(&instructions),
                    response_format: None,
                    cache_scope: Some(&cache_scope),
                    cache_boundary: None,
                    cancellation: cancellation.clone(),
                    attachments: &[],
                    butler_data: Some(&root),
                    usage_attribution: None,
                    stream_observer: None,
                    provider_retry_attempts: None,
                },
                ProviderPromptLifecycle::none(),
            )
            .await
            .map_err(|_| error("new_chat_briefing_model_failed", "Briefing model failed"))?;
        ensure_active(cancellation)?;
        usage.push(
            if response.model.is_empty() {
                model
            } else {
                &response.model
            },
            response.usage.as_ref(),
        );
        let artifact = artifact::from_model(
            &response.text,
            artifact::BriefingArtifactContext {
                input,
                project,
                now,
                local_minute,
                run_id,
                model,
                reasoning: reasoning.as_str(),
            },
        )?;
        let path = write::artifact_path(
            &self.data_root,
            &now.format("%Y-%m-%d").to_string(),
            project.map(|project| project.id.as_str()),
        );
        let lock = self
            .data_root
            .join("cognition/consolidation/locks/consolidation.lock");
        let mut request = CognitionWriteAcquire::immediate(lock.clone(), "consolidation");
        request.cancellation = Some(cancellation.clone());
        let lease = self
            .coordinator
            .acquire(request, CognitionWaitClass::Background)
            .await
            .map_err(|failure| error("new_chat_briefing_write_failed", failure.message))?
            .ok_or_else(|| error("memory_write_busy", "Memory writer is busy"))?;
        lease
            .assert_for_path(&lock)
            .map_err(|failure| error("new_chat_briefing_write_failed", failure.message))?;
        let current = self.source.snapshot().await?;
        ensure_active(cancellation)?;
        if prepared_fingerprint(input, project.map(|project| project.id.as_str()))
            != prepared_fingerprint(&current, project.map(|project| project.id.as_str()))
        {
            return Err(error(
                "memory_source_changed",
                "Briefing inputs changed before commit",
            ));
        }
        let result = write::write(&path, &artifact);
        let release = lease
            .release(result.is_ok())
            .map_err(|failure| error("new_chat_briefing_write_failed", failure.message));
        release?;
        result?;
        Ok(path.to_string_lossy().into_owned())
    }
}

fn metrics(input: &BriefingMetrics) -> Map<String, Value> {
    crate::json::json_object!({
        "outcome":input.outcome, "skip_reason":input.reason, "generated_count":input.generated,
        "failed_count":input.failed, "skipped_project_count":input.skipped,
        "general_artifact_path":input.general, "project_artifact_paths":input.projects,
        "model_ref":input.model, "reasoning_effort":input.reasoning,
        "model_usage":input.usage.value(), "raw_text_included":false,
    })
}

fn ensure_active(cancellation: &CancellationToken) -> Result<(), BriefingGenerationError> {
    if cancellation.is_cancelled() {
        Err(error(
            "new_chat_briefing_cancelled",
            "Briefing generation cancelled",
        ))
    } else {
        Ok(())
    }
}
