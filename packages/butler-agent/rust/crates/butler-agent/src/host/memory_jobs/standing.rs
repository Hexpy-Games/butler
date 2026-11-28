//! Daily folds of global user statements into a standing-fact sheet.
use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};

use butler_memory::{
    cognition::{self, CognitionPathEnvironment},
    profile::ProfileService,
};
use butler_models::models::{
    ModelProvider, PromptUsageAttribution, ProviderPromptLifecycle, ProviderPromptPort,
    ProviderPromptRequest,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::host::HostError;

pub(in crate::host) struct StandingFacts {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    profile: Arc<ProfileService>,
    provider: Arc<ModelProvider>,
}

/// What one refresh did, for the cycle log.
#[derive(Default)]
struct FoldEffect {
    calls: u64,
    prompt_tokens: f64,
    output_tokens: f64,
    sources_before: u64,
    sources_after: u64,
    text_before: String,
    text_after: String,
}

impl FoldEffect {
    fn event(&self, error: Option<&HostError>, duration: Duration) -> Value {
        let before: HashSet<_> = self
            .text_before
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let after: HashSet<_> = self
            .text_after
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let mut event = json!({
            "phase": "standing_facts",
            "status": if error.is_some() { "error" } else { "ok" },
            "duration_ms": duration.as_millis(),
            "metrics": {
                "calls": self.calls,
                "prompt_tokens": self.prompt_tokens,
                "output_tokens": self.output_tokens,
                "sources_folded": self.sources_after.saturating_sub(self.sources_before),
                "lines_added": after.difference(&before).count(),
                "lines_removed": before.difference(&after).count(),
                "bytes": self.text_after.len(),
            },
        });
        if let Some(error) = error {
            event["error"] = json!({"name": error.message()});
        }
        event
    }
}

impl StandingFacts {
    pub(super) fn new(owners: &super::daily::DailyCognitionOwners) -> Self {
        Self {
            data_root: owners.data_root.clone(),
            paths: owners.paths.clone(),
            profile: owners.profile.clone(),
            provider: owners.provider.clone(),
        }
    }

    pub(in crate::host) async fn refresh(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(), HostError> {
        let started = std::time::Instant::now();
        let mut effect = FoldEffect::default();
        let result = self.fold(cancellation, &mut effect).await;
        if effect.calls > 0 {
            let event = effect.event(result.as_ref().err(), started.elapsed());
            if let Err(error) =
                cognition::append_cycle_event(&self.data_root, &self.paths, event).await
            {
                butler_core::diagnostic!("[standing-facts] event {}", error.code());
            }
        }
        result
    }

    async fn fold(
        &self,
        cancellation: &CancellationToken,
        effect: &mut FoldEffect,
    ) -> Result<(), HostError> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let Some((generation, mut sheet)) = tokio::task::spawn_blocking(move || {
            if !cognition::active_memory_descriptor_exists(&data_root, &paths)? {
                return Ok(None);
            }
            let generation = cognition::resolve_active_generation(&data_root, &paths)?;
            let sheet = cognition::standing_start(&generation.graph_path, &generation.root)?;
            Ok::<_, cognition::CognitionError>(Some((generation, sheet)))
        })
        .await
        .map_err(failure)?
        .map_err(failure)?
        else {
            return Ok(());
        };
        effect.sources_before = sheet.sources;
        effect.sources_after = sheet.sources;
        effect.text_before = sheet.text.clone();
        effect.text_after = sheet.text.clone();
        loop {
            if cancellation.is_cancelled() {
                return Ok(());
            }
            let graph_path = generation.graph_path.clone();
            let (previous, batch) = tokio::task::spawn_blocking(move || {
                cognition::standing_batch(&graph_path, &sheet).map(|batch| (sheet, batch))
            })
            .await
            .map_err(failure)?
            .map_err(failure)?;
            let Some(batch) = batch else {
                return Ok(());
            };
            let model = self.profile.read_extractor_model().await.map_err(failure)?;
            let prompt = cognition::standing_prompt(&previous.text, &batch.lines);
            let mut text = self
                .summarize(&model, &prompt, cancellation, effect)
                .await?;
            for _ in 0..3 {
                if text.len() <= cognition::STANDING_MAX_BYTES {
                    break;
                }
                let prompt = cognition::standing_shorten_prompt(&text);
                text = self
                    .summarize(&model, &prompt, cancellation, effect)
                    .await?;
            }
            if text.len() > cognition::STANDING_MAX_BYTES {
                return Err(HostError::new("standing_facts_reply_invalid"));
            }
            sheet = cognition::StandingSheet {
                text,
                through_at: batch.through_at,
                through_id: batch.through_id,
                sources: batch.sources,
            };
            let Some(published) = self
                .publish(&generation, sheet, &model.effective_model)
                .await?
            else {
                return Ok(());
            };
            effect.sources_after = published.sources;
            effect.text_after = published.text.clone();
            sheet = published;
        }
    }

    async fn publish(
        &self,
        generation: &cognition::MemoryGenerationHandle,
        sheet: cognition::StandingSheet,
        model: &str,
    ) -> Result<Option<cognition::StandingSheet>, HostError> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let generation_id = generation.generation_id.clone();
        let root = generation.root.clone();
        let model = model.to_owned();
        tokio::task::spawn_blocking(move || {
            let active =
                cognition::resolve_active_generation(&data_root, &paths).map_err(failure)?;
            if active.generation_id != generation_id {
                return Ok(None);
            }
            cognition::write_standing(&root, &sheet, &model).map_err(failure)?;
            Ok(Some(sheet))
        })
        .await
        .map_err(failure)?
    }

    async fn summarize(
        &self,
        model: &butler_memory::profile::ProfilingExtractorModelSnapshot,
        prompt: &str,
        cancellation: &CancellationToken,
        effect: &mut FoldEffect,
    ) -> Result<String, HostError> {
        let effort: butler_models::models::ReasoningEffort =
            serde_json::from_value(serde_json::Value::String(model.reasoning_effort.clone()))
                .map_err(failure)?;
        let root = self.data_root.to_string_lossy();
        let attribution = PromptUsageAttribution::for_phase("standing_facts");
        effect.calls += 1;
        let reply = self
            .provider
            .run_prompt(
                ProviderPromptRequest {
                    prompt,
                    model: Some(&model.effective_model),
                    reasoning_effort: Some(&effort),
                    instructions: Some(cognition::STANDING_INSTRUCTIONS),
                    response_format: None,
                    cache_scope: Some("standing-facts"),
                    cache_boundary: None,
                    cancellation: cancellation.child_token(),
                    attachments: &[],
                    butler_data: Some(&root),
                    usage_attribution: Some(&attribution),
                    stream_observer: None,
                    provider_retry_attempts: None,
                },
                ProviderPromptLifecycle::none(),
            )
            .await
            .map_err(failure)?;
        if let Some(usage) = reply.usage {
            let prompt_tokens = usage.prompt_tokens.unwrap_or(0.0);
            if prompt_tokens.is_finite() && prompt_tokens >= 0.0 {
                effect.prompt_tokens += prompt_tokens;
            }
            if usage.output_tokens.is_finite() && usage.output_tokens >= 0.0 {
                effect.output_tokens += usage.output_tokens;
            }
        }
        let text = reply.text.trim();
        if text.is_empty() {
            return Err(HostError::new("standing_facts_reply_invalid"));
        }
        Ok(text.to_owned())
    }
}

fn failure(error: impl std::error::Error + Send + Sync + 'static) -> HostError {
    HostError::new("standing_facts_failed").with_source(error)
}
