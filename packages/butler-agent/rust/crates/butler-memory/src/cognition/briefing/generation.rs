//! New-chat briefings: after consolidation, a short model-written opener
//! for a new chat (general and per active project), written under the
//! consolidation lock when its inputs did not change meanwhile.

mod artifact;
mod contracts;
mod error;
mod prompt;
#[cfg(test)]
mod tests;
mod usage;
mod write;

use std::{path::PathBuf, sync::Arc};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator};
use butler_models::models::{
    ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest, ReasoningEffort,
};

pub use contracts::{
    BriefingGenerationCode, BriefingGenerationError, BriefingInputFuture, BriefingInputSnapshot,
    BriefingInputSource, BriefingPersona, BriefingProjectSignal, BriefingSettings,
};
use contracts::{error, prepared_fingerprint};
use usage::Usage;

#[derive(Clone, Copy)]
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

/// The metrics a generation run reports, in the reported key order.
#[derive(Serialize)]
struct BriefingMetrics {
    outcome: &'static str,
    skip_reason: Option<&'static str>,
    generated_count: u64,
    failed_count: u64,
    skipped_project_count: u64,
    general_artifact_path: Option<String>,
    project_artifact_paths: Vec<String>,
    model_ref: Option<String>,
    reasoning_effort: Option<ReasoningEffort>,
    model_usage: usage::UsageSummary,
    raw_text_included: bool,
}

/// What the briefings of one run produced so far.
#[derive(Default)]
struct Tally {
    generated: u64,
    failed: u64,
    skipped: u64,
    general: Option<String>,
    projects: Vec<String>,
    usage: Usage,
}

impl Tally {
    /// Counts one briefing; its artifact path when it was written.
    /// Cancellation ends the run.
    fn count(
        &mut self,
        outcome: Result<String, BriefingGenerationError>,
    ) -> Result<Option<String>, BriefingGenerationError> {
        match outcome {
            Ok(path) => {
                self.generated += 1;
                Ok(Some(path))
            }
            Err(error) if error.code() == "new_chat_briefing_cancelled" => Err(error),
            Err(_) => {
                self.failed += 1;
                Ok(None)
            }
        }
    }
}

pub struct BriefingGenerationService {
    data_root: PathBuf,
    coordinator: Arc<CognitionWriteCoordinator>,
    provider: Arc<dyn ProviderPromptPort>,
    source: Arc<dyn BriefingInputSource>,
}

impl BriefingGenerationService {
    pub fn new(
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

    /// Writes the general briefing and one per project with recent
    /// activity; the run metrics.
    pub async fn generate(
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
                return Ok(metrics(BriefingMetrics {
                    outcome: "configuration_unavailable",
                    skip_reason: Some(reason),
                    generated_count: 0,
                    failed_count: 0,
                    skipped_project_count: 0,
                    general_artifact_path: None,
                    project_artifact_paths: vec![],
                    model_ref: None,
                    reasoning_effort: None,
                    model_usage: Usage::default().summary(),
                    raw_text_included: false,
                }));
            }
        };
        let local_minute = self.source.local_minute(now.timestamp_millis())?;
        let context = |project| BriefingRunContext {
            input: &input,
            project,
            run_id,
            now,
            local_minute,
            model: &model,
            reasoning,
            cancellation,
        };
        let mut tally = Tally::default();
        let general = self.run_one(context(None), &mut tally.usage).await;
        tally.general = tally.count(general)?;
        for project in &input.projects {
            ensure_active(cancellation)?;
            if project.recent_session_titles.is_empty() && project.ledger_event_summary.is_empty() {
                tally.skipped += 1;
                continue;
            }
            let written = self.run_one(context(Some(project)), &mut tally.usage).await;
            if let Some(path) = tally.count(written)? {
                tally.projects.push(path);
            }
        }
        Ok(metrics(BriefingMetrics {
            outcome: "completed",
            skip_reason: None,
            generated_count: tally.generated,
            failed_count: tally.failed,
            skipped_project_count: tally.skipped,
            general_artifact_path: tally.general,
            project_artifact_paths: tally.projects,
            model_ref: Some(model.clone()),
            reasoning_effort: Some(reasoning),
            model_usage: tally.usage.summary(),
            raw_text_included: false,
        }))
    }

    async fn run_one(
        &self,
        context: BriefingRunContext<'_>,
        usage: &mut Usage,
    ) -> Result<String, BriefingGenerationError> {
        ensure_active(context.cancellation)?;
        let reply = self.ask_model(&context, usage).await?;
        let artifact = artifact::from_model(
            &reply,
            artifact::BriefingArtifactContext {
                input: context.input,
                project: context.project,
                now: context.now,
                local_minute: context.local_minute,
                run_id: context.run_id,
                model: context.model,
                reasoning: context.reasoning.as_str(),
            },
        )?;
        let path = write::artifact_path(
            &self.data_root,
            &context.now.format("%Y-%m-%d").to_string(),
            context.project.map(|project| project.id.as_str()),
        );
        self.commit(&context, &path, &artifact).await?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Asks the briefing model for this briefing; the raw reply.
    async fn ask_model(
        &self,
        context: &BriefingRunContext<'_>,
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
        } = *context;
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
            .map_err(|source| {
                error(
                    BriefingGenerationCode::NewChatBriefingModelFailed,
                    "Briefing model failed",
                )
                .with_source(source)
            })?;
        ensure_active(cancellation)?;
        usage.push(
            if response.model.is_empty() {
                model
            } else {
                &response.model
            },
            response.usage.as_ref(),
        );
        Ok(response.text)
    }

    /// Writes the artifact under the consolidation lock, provided the
    /// briefing inputs did not change while the model ran.
    async fn commit(
        &self,
        context: &BriefingRunContext<'_>,
        path: &std::path::Path,
        artifact: &artifact::BriefingArtifact<'_>,
    ) -> Result<(), BriefingGenerationError> {
        let write_failed = |failure: crate::coordination::CoordinationError| {
            error(
                BriefingGenerationCode::NewChatBriefingWriteFailed,
                failure.message(),
            )
            .with_source(failure)
        };
        let lock = self
            .data_root
            .join("cognition/consolidation/locks/consolidation.lock");
        let mut request = CognitionWriteAcquire::immediate(lock.clone(), "consolidation");
        request.cancellation = Some(context.cancellation.clone());
        let lease = self
            .coordinator
            .acquire(request, CognitionWaitClass::Background)
            .await
            .map_err(write_failed)?
            .ok_or_else(|| {
                error(
                    BriefingGenerationCode::MemoryWriteBusy,
                    "Memory writer is busy",
                )
            })?;
        lease.assert_for_path(&lock).map_err(write_failed)?;
        let current = self.source.snapshot().await?;
        ensure_active(context.cancellation)?;
        let project_id = context.project.map(|project| project.id.as_str());
        if prepared_fingerprint(context.input, project_id)
            != prepared_fingerprint(&current, project_id)
        {
            return Err(error(
                BriefingGenerationCode::MemorySourceChanged,
                "Briefing inputs changed before commit",
            ));
        }
        let result = write::write(path, artifact);
        let release = lease.release(result.is_ok()).map_err(write_failed);
        release?;
        result
    }
}

fn metrics(metrics: BriefingMetrics) -> Map<String, Value> {
    match serde_json::to_value(metrics) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn ensure_active(cancellation: &CancellationToken) -> Result<(), BriefingGenerationError> {
    if cancellation.is_cancelled() {
        Err(error(
            BriefingGenerationCode::NewChatBriefingCancelled,
            "Briefing generation cancelled",
        ))
    } else {
        Ok(())
    }
}
