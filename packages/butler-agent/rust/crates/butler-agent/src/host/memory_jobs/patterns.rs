//! Host composition: consent, shared consolidation model selection and canonical source pages.
use super::consolidation::ConsolidationRunGate;
use butler_memory::{
    cognition::{
        BriefingSettings, PatternError, PatternEvent, PatternExtractionService, PatternFuture,
        PatternInput, PatternInputSource, PatternRepository,
    },
    coordination::CognitionWriteCoordinator,
    profile::{ProfileService, ProfilingMode},
};
use butler_models::models::{ModelConfiguration, ModelProvider};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

struct Source {
    root: PathBuf,
    models: Arc<ModelConfiguration>,
    profile: Arc<ProfileService>,
    gate: Arc<ConsolidationRunGate>,
}
pub(super) fn compose(
    root: PathBuf,
    coordinator: Arc<CognitionWriteCoordinator>,
    provider: Arc<ModelProvider>,
    models: Arc<ModelConfiguration>,
    profile: Arc<ProfileService>,
    gate: Arc<ConsolidationRunGate>,
) -> PatternExtractionService {
    let repository = PatternRepository::new(root.clone(), coordinator);
    PatternExtractionService::new(
        root.clone(),
        repository,
        provider,
        Arc::new(Source {
            root,
            models,
            profile,
            gate,
        }),
    )
}
impl PatternInputSource for Source {
    fn learning_depth(&self) -> PatternFuture<'_, Option<String>> {
        Box::pin(async move {
            let consent = self
                .profile
                .read_profiling_consent()
                .await
                .map_err(PatternError::port)?;
            Ok(match consent.mode {
                ProfilingMode::Off => None,
                ProfilingMode::Basic => Some("basic".into()),
                ProfilingMode::Deep => Some("deep".into()),
            })
        })
    }
    fn settings(&self) -> PatternFuture<'_, PatternInput> {
        Box::pin(async move {
            let read = self.models.read().await.map_err(PatternError::port)?;
            let path =
                crate::host::service::configuration::AppServiceConfiguration::capture(&self.root)
                    .db_path;
            let app = tokio::task::spawn_blocking(move || {
                butler_gateway::gateway::read_new_chat_briefing_settings(&path)
            })
            .await
            .map_err(PatternError::port)?;
            let settings = super::briefing::settings(&read.config, Some(&app), &read.catalog);
            let BriefingSettings::Configured {
                locale,
                model,
                reasoning_effort,
            } = settings
            else {
                return Err(PatternError::port(std::io::Error::other(
                    "Consolidation model unavailable",
                )));
            };
            Ok(PatternInput {
                learning_depth: String::new(),
                locale,
                model,
                reasoning: reasoning_effort,
                timezone: read
                    .config
                    .pointer("/user/timezone")
                    .and_then(Value::as_str)
                    .unwrap_or("local")
                    .into(),
                level: read
                    .config
                    .pointer("/proactive/level")
                    .and_then(Value::as_str)
                    .unwrap_or("sometimes")
                    .into(),
            })
        })
    }
    fn page(&self, since: DateTime<Utc>, offset: usize) -> PatternFuture<'_, Vec<PatternEvent>> {
        let path = butler_turn::conversation::conversation_store_path(&self.root);
        let timezone = self.gate.schedule().timezone;
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                super::pattern_sources::read_page(&path, &timezone, since, offset)
            })
            .await
            .map_err(PatternError::port)?
        })
    }
}
