//! Manual-cycle New Chat Briefing composition over existing domain owners.

use std::{path::PathBuf, sync::Arc};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::{
    btcc::BtccError,
    cognition::{
        BriefingGenerationError, BriefingGenerationService, BriefingInputFuture,
        BriefingInputSnapshot, BriefingInputSource, BriefingPersona, BriefingProjectSignal,
        BriefingSettings, CognitionPathEnvironment,
    },
    configuration::ConfigurationWrites,
    coordination::CognitionWriteCoordinator,
    gateway::{read_new_chat_briefing_projects, read_new_chat_briefing_settings},
    locale::LocaleCollation,
    models::{ModelConfiguration, NativeModelProvider, ProviderAuthMethod, ReasoningEffort},
    profile::{PersonaPresets, ProfileService, active_briefing_persona},
    project_ledger::{NativeProjectLedger, ProjectBriefingTarget},
};

use super::{
    NativeDateParser, NativeProcessEnvironment, NativeProcessModels, ProfileConversationSources,
    SystemIdentity,
};

pub(super) struct NativeBriefingGeneration {
    generator: BriefingGenerationService,
    profile: Arc<ProfileService>,
    ledger: NativeProjectLedger,
    _models: Option<NativeProcessModels>,
    owns_profile_and_ledger: bool,
}

struct NativeBriefingSource {
    data_root: PathBuf,
    app_database_path: PathBuf,
    cognition_paths: CognitionPathEnvironment,
    models: Arc<ModelConfiguration>,
    profile: Arc<ProfileService>,
    ledger: NativeProjectLedger,
    date_parser: Arc<NativeDateParser>,
}

impl NativeBriefingGeneration {
    pub(super) fn open(
        data_root: PathBuf,
        resource_root: PathBuf,
        environment: NativeProcessEnvironment,
    ) -> Result<Self, BtccError> {
        let date_parser = NativeDateParser::from_process().map_err(setup)?;
        let collation = Arc::new(LocaleCollation::new("en-US").map_err(setup)?);
        let writes = Arc::new(ConfigurationWrites::new());
        let models = NativeProcessModels::new(
            data_root.clone(),
            environment.model,
            writes.clone(),
            collation.clone(),
        )?;
        let coordinator =
            Arc::new(CognitionWriteCoordinator::new(Arc::new(SystemIdentity)).map_err(setup)?);
        let profile = Arc::new(ProfileService::new(
            data_root.clone(),
            environment.cognition_paths.cognition_root(&data_root),
            Arc::new(PersonaPresets::new(resource_root)),
            writes,
            coordinator.clone(),
            Arc::new(SystemIdentity),
            Arc::new(ProfileConversationSources::new(
                crate::conversation::conversation_store_path(&data_root),
            )),
            models.provider.clone(),
        ));
        let ledger = NativeProjectLedger::with_collation(&data_root, 2, collation);
        let app_database_path =
            super::service_configuration::NativeAppServiceConfiguration::capture(&data_root)
                .db_path;
        let source = Arc::new(NativeBriefingSource {
            data_root: data_root.clone(),
            app_database_path,
            cognition_paths: environment.cognition_paths.clone(),
            models: models.configuration.clone(),
            profile: profile.clone(),
            ledger: ledger.clone(),
            date_parser: Arc::new(date_parser),
        });
        let generator =
            BriefingGenerationService::new(data_root, coordinator, models.provider.clone(), source);
        Ok(Self {
            generator,
            profile,
            ledger,
            _models: Some(models),
            owns_profile_and_ledger: true,
        })
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "runtime composition supplies eight required existing domain owners"
    )]
    pub(super) fn from_runtime(
        data_root: PathBuf,
        coordinator: Arc<CognitionWriteCoordinator>,
        provider: Arc<NativeModelProvider>,
        configuration: Arc<ModelConfiguration>,
        profile: Arc<ProfileService>,
        ledger: NativeProjectLedger,
        date_parser: Arc<NativeDateParser>,
        cognition_paths: CognitionPathEnvironment,
    ) -> Self {
        let app_database_path =
            super::service_configuration::NativeAppServiceConfiguration::capture(&data_root)
                .db_path;
        let source = Arc::new(NativeBriefingSource {
            data_root: data_root.clone(),
            app_database_path,
            cognition_paths,
            models: configuration,
            profile: profile.clone(),
            ledger: ledger.clone(),
            date_parser,
        });
        let generator = BriefingGenerationService::new(data_root, coordinator, provider, source);
        Self {
            generator,
            profile,
            ledger,
            _models: None,
            owns_profile_and_ledger: false,
        }
    }

    pub(super) async fn generate(
        &self,
        run_id: &str,
        now: DateTime<Utc>,
        cancellation: &CancellationToken,
    ) -> Result<Map<String, Value>, BriefingGenerationError> {
        self.generator.generate(run_id, now, cancellation).await
    }

    pub(super) async fn close(&self) {
        if self.owns_profile_and_ledger {
            self.profile.close().await;
            self.ledger.close().await;
        }
    }

    pub(super) fn profile(&self) -> Arc<ProfileService> {
        self.profile.clone()
    }
}

impl BriefingInputSource for NativeBriefingSource {
    fn local_minute(&self, epoch_ms: i64) -> Result<u16, BriefingGenerationError> {
        self.date_parser
            .local_day_and_minute(epoch_ms)
            .map(|(_, minute)| minute)
            .map_err(|failure| {
                BriefingGenerationError::new("new_chat_briefing_time_failed", failure.message)
            })
    }
    fn snapshot(&self) -> BriefingInputFuture<'_> {
        Box::pin(async move {
            let read = self.models.read().await.map_err(|failure| {
                BriefingGenerationError::new(
                    "new_chat_briefing_settings_failed",
                    failure.to_string(),
                )
            })?;
            let app_path = self.app_database_path.clone();
            let app_settings =
                tokio::task::spawn_blocking(move || read_new_chat_briefing_settings(&app_path))
                    .await
                    .map_err(|_| {
                        BriefingGenerationError::new(
                            "new_chat_briefing_app_read_failed",
                            "App briefing read worker failed",
                        )
                    })?;
            let settings = settings(&read.config, Some(&app_settings), &read.catalog);
            if matches!(settings, BriefingSettings::Unavailable { .. }) {
                return Ok(BriefingInputSnapshot {
                    settings,
                    persona: BriefingPersona {
                        id: None,
                        text: None,
                    },
                    projection: None,
                    projects: vec![],
                });
            }
            let (id, text) = active_briefing_persona(&self.data_root);
            let projection = self
                .profile
                .read_runtime_profile_projection()
                .await
                .map_err(|failure| {
                    BriefingGenerationError::new(
                        "new_chat_briefing_profile_failed",
                        failure.message,
                    )
                })?;
            let app_path = self.app_database_path.clone();
            let app_projects =
                tokio::task::spawn_blocking(move || read_new_chat_briefing_projects(&app_path))
                    .await
                    .map_err(|_| {
                        BriefingGenerationError::new(
                            "new_chat_briefing_app_read_failed",
                            "App project read worker failed",
                        )
                    })?
                    .map_err(|_| {
                        BriefingGenerationError::new(
                            "new_chat_briefing_app_read_failed",
                            "App project snapshot could not be read",
                        )
                    })?;
            let targets = app_projects.map(|projects| {
                projects
                    .into_iter()
                    .map(|project| ProjectBriefingTarget {
                        id: project.id.clone(),
                        display_name: project.display_name,
                        ledger_project_id: project
                            .ledger_project_id
                            .filter(|id| !id.is_empty())
                            .unwrap_or(project.id),
                        recent_session_titles: project.recent_session_titles,
                    })
                    .collect()
            });
            let consolidation_root = self
                .cognition_paths
                .cognition_root(&self.data_root)
                .join("consolidation");
            let projects = self
                .ledger
                .briefing_signals(targets, consolidation_root)
                .await
                .map_err(|failure| {
                    BriefingGenerationError::new(
                        "new_chat_briefing_ledger_failed",
                        format!("{failure:?}"),
                    )
                })?
                .into_iter()
                .map(|project| BriefingProjectSignal {
                    id: project.id,
                    display_name: project.display_name,
                    summary: project.summary,
                    recent_session_titles: project.recent_session_titles,
                    ledger_event_summary: project.ledger_event_summary,
                    open_work_titles: project.open_work_titles,
                    completed_work_titles: project.completed_work_titles,
                    excluded_topics: project.excluded_topics,
                })
                .collect();
            Ok(BriefingInputSnapshot {
                settings,
                persona: BriefingPersona { id, text },
                projection,
                projects,
            })
        })
    }
}

fn settings(
    config: &Value,
    app_settings: Option<&Value>,
    catalog: &crate::models::ModelCatalogSnapshot,
) -> BriefingSettings {
    let locale = locale_preference(config, app_settings);
    let selected = model_preference(config, app_settings);
    let Some(selected) = selected
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return unavailable(locale, "missing_model");
    };
    let selected = crate::models::parse_model_ref(selected);
    if selected.model_id.is_empty() {
        return unavailable(locale, "missing_model");
    }
    let effort = reasoning_preference(config, app_settings);
    let Some(effort) = effort.filter(|value| !value.is_null()) else {
        return unavailable(locale, "missing_reasoning_effort");
    };
    let Ok(reasoning_effort) = serde_json::from_value::<ReasoningEffort>(effort.clone()) else {
        return unavailable(locale, "invalid_reasoning_effort");
    };
    let Some(metadata) = catalog.find_model_metadata(Some(&selected.canonical_ref)) else {
        return unavailable(locale, "model_unavailable");
    };
    if !metadata.runtime_supported
        || metadata.enabled == Some(false)
        || metadata.registered == Some(false)
        || (metadata.auth_type == Some(ProviderAuthMethod::ApiKey)
            && metadata.credential_masked_value.is_none())
    {
        return unavailable(locale, "model_unavailable");
    }
    if !metadata.reasoning_efforts.contains(&reasoning_effort) {
        return unavailable(locale, "reasoning_effort_unsupported");
    }
    if !matches!(
        metadata.provider_id.as_str(),
        "openai"
            | "anthropic"
            | "google"
            | "xai"
            | "qwen"
            | "kimi"
            | "zai"
            | "zai-api"
            | "opencode-go"
            | "local"
    ) {
        return unavailable(locale, "provider_route_unavailable");
    }
    BriefingSettings::Configured {
        locale,
        model: metadata.model_ref,
        reasoning_effort,
    }
}

fn locale_preference(config: &Value, app_settings: Option<&Value>) -> String {
    if first_non_null([
        app_settings.and_then(|settings| settings.get("language")),
        config.pointer("/user/language"),
        config.get("language"),
    ])
    .and_then(Value::as_str)
        == Some("ko")
    {
        "ko"
    } else {
        "en"
    }
    .to_owned()
}

fn model_preference<'a>(config: &'a Value, app_settings: Option<&'a Value>) -> Option<&'a Value> {
    let selected = first_non_null([
        config.pointer("/personalization/profiling/extractorModel"),
        config.get("consolidation_model"),
        app_settings.and_then(|settings| settings.get("consolidation_model")),
    ]);
    if selected.is_none() || selected.is_some_and(is_default_model_sentinel) {
        first_non_null([
            app_settings.and_then(|settings| settings.get("model")),
            config.pointer("/system/butlerModel"),
            config.pointer("/system/defaultModel"),
            config.get("model"),
        ])
    } else {
        selected
    }
}

fn reasoning_preference<'a>(
    config: &'a Value,
    app_settings: Option<&'a Value>,
) -> Option<&'a Value> {
    first_non_null([
        config.pointer("/personalization/profiling/extractorReasoningEffort"),
        config.get("consolidation_reasoning_effort"),
        app_settings.and_then(|settings| settings.get("consolidation_reasoning_effort")),
        app_settings.and_then(|settings| settings.get("reasoning_effort")),
        config.get("reasoning_effort"),
    ])
}

fn first_non_null<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> Option<&'a Value> {
    values.into_iter().flatten().find(|value| !value.is_null())
}

fn is_default_model_sentinel(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("default" | "custom/default" | "butler")
    )
}

fn unavailable(locale: String, reason: &'static str) -> BriefingSettings {
    BriefingSettings::Unavailable { locale, reason }
}

fn setup(error: impl std::fmt::Display) -> BtccError {
    BtccError::new("new_chat_briefing_setup_failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{locale_preference, model_preference, reasoning_preference};

    #[test]
    fn model_locale_and_effort_follow_source_priority() {
        let config = json!({
            "language":"en",
            "user":{"language":"fr"},
            "model":"openai/config-model",
            "consolidation_model":"openai/consolidation-model",
            "reasoning_effort":"low",
            "consolidation_reasoning_effort":"high",
            "personalization":{"profiling":{
                "extractorModel":"openai/extractor-model",
                "extractorReasoningEffort":"xhigh",
            }},
        });
        let app = json!({
            "language":"ko", "model":"openai/app-model",
            "consolidation_model":"openai/app-consolidation-model",
            "reasoning_effort":"medium", "consolidation_reasoning_effort":"max",
        });
        assert_eq!(locale_preference(&config, Some(&app)), "ko");
        assert_eq!(
            model_preference(&config, Some(&app)).and_then(Value::as_str),
            Some("openai/extractor-model")
        );
        assert_eq!(
            reasoning_preference(&config, Some(&app)).and_then(Value::as_str),
            Some("xhigh")
        );
    }

    #[test]
    fn default_model_sentinels_fall_back_to_app_then_system_default() {
        let config = json!({
            "model":"openai/config-model",
            "consolidation_model":"default",
            "system":{"butlerModel":"openai/butler-model","defaultModel":"openai/system-model"},
        });
        let app = json!({"model":"openai/app-model"});
        assert_eq!(
            model_preference(&config, Some(&app)).and_then(Value::as_str),
            Some("openai/app-model")
        );
        assert_eq!(
            model_preference(&config, None).and_then(Value::as_str),
            Some("openai/butler-model")
        );
    }
}
