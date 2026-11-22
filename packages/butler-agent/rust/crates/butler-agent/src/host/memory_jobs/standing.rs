//! Daily folds of global user statements into a standing-fact sheet.
use std::{path::PathBuf, sync::Arc};

use butler_memory::{
    cognition::{self, CognitionPathEnvironment},
    profile::ProfileService,
};
use butler_models::models::{
    ModelProvider, PromptUsageAttribution, ProviderPromptLifecycle, ProviderPromptPort,
    ProviderPromptRequest,
};
use tokio_util::sync::CancellationToken;

use crate::host::HostError;

pub(in crate::host) struct StandingFacts {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    profile: Arc<ProfileService>,
    provider: Arc<ModelProvider>,
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
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let (generation, mut sheet) = tokio::task::spawn_blocking(move || {
            let generation = cognition::resolve_active_generation(&data_root, &paths)?;
            let sheet = cognition::standing_start(&generation.graph_path, &generation.root)?;
            Ok::<_, cognition::CognitionError>((generation, sheet))
        })
        .await
        .map_err(failure)?
        .map_err(failure)?;
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
            let mut text = self.summarize(&model, &prompt, cancellation).await?;
            if text.len() > cognition::STANDING_MAX_BYTES {
                let prompt = format!(
                    "This sheet is {} bytes. Shorten it to under 4,096 UTF-8 bytes by dropping the least lasting lines. Return only the sheet.\n\n{text}",
                    text.len()
                );
                text = self.summarize(&model, &prompt, cancellation).await?;
            }
            if text.is_empty() || text.len() > cognition::STANDING_MAX_BYTES {
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
    ) -> Result<String, HostError> {
        let effort: butler_models::models::ReasoningEffort =
            serde_json::from_value(serde_json::Value::String(model.reasoning_effort.clone()))
                .map_err(failure)?;
        let root = self.data_root.to_string_lossy();
        let attribution = PromptUsageAttribution::for_phase("standing_facts");
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
