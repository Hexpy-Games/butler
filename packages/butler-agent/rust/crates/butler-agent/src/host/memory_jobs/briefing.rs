//! Manual-cycle New Chat Briefing composition over existing domain owners.

use std::{path::PathBuf, sync::Arc};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::cognition::BriefingGenerationError;
use crate::cognition::BriefingGenerationService;
use crate::cognition::BriefingInputFuture;
use crate::cognition::BriefingInputSnapshot;
use crate::cognition::BriefingInputSource;
use crate::cognition::BriefingPersona;
use crate::cognition::BriefingProjectSignal;
use crate::cognition::BriefingSettings;
use crate::cognition::CognitionPathEnvironment;
use crate::coordination::CognitionWriteCoordinator;
use crate::gateway::read_new_chat_briefing_projects;
use crate::gateway::read_new_chat_briefing_settings;
use crate::profile::PersonaPresets;
use crate::profile::ProfileService;
use crate::profile::active_briefing_persona;
use butler_core::configuration::ConfigurationWrites;
use butler_core::locale::LocaleCollation;
use butler_ledger::project_ledger::ProjectBriefingTarget;
use butler_ledger::project_ledger::ProjectLedger;
use butler_models::models::ModelConfiguration;
use butler_models::models::ModelProvider;
use butler_models::models::ProviderAuthMethod;
use butler_models::models::ReasoningEffort;
use butler_turn::btcc::BtccError;

use crate::cognition::BriefingGenerationCode;
use crate::host::{
    DateParser, ProcessEnvironment, ProcessModels, ProfileConversationSources, SystemIdentity,
};

pub(in crate::host) struct BriefingGeneration {
    generator: BriefingGenerationService,
    profile: Arc<ProfileService>,
    ledger: ProjectLedger,
    _models: Option<ProcessModels>,
    owns_profile_and_ledger: bool,
}

struct BriefingSource {
    data_root: PathBuf,
    app_database_path: PathBuf,
    cognition_paths: CognitionPathEnvironment,
    models: Arc<ModelConfiguration>,
    profile: Arc<ProfileService>,
    ledger: ProjectLedger,
    date_parser: Arc<DateParser>,
}

impl BriefingGeneration {
    pub(in crate::host) fn open(
        data_root: PathBuf,
        resource_root: PathBuf,
        environment: ProcessEnvironment,
    ) -> Result<Self, BtccError> {
        let date_parser = DateParser::from_process().map_err(setup)?;
        let collation = Arc::new(LocaleCollation::new("en-US").map_err(setup)?);
        let writes = Arc::new(ConfigurationWrites::new());
        let models = ProcessModels::new(
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
                butler_turn::conversation::conversation_store_path(&data_root),
            )),
            models.provider.clone(),
        ));
        let ledger = ProjectLedger::with_collation(&data_root, 2, collation);
        let app_database_path =
            crate::host::service::configuration::AppServiceConfiguration::capture(&data_root)
                .db_path;
        let source = Arc::new(BriefingSource {
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
    pub(in crate::host) fn from_runtime(
        data_root: PathBuf,
        coordinator: Arc<CognitionWriteCoordinator>,
        provider: Arc<ModelProvider>,
        configuration: Arc<ModelConfiguration>,
        profile: Arc<ProfileService>,
        ledger: ProjectLedger,
        date_parser: Arc<DateParser>,
        cognition_paths: CognitionPathEnvironment,
    ) -> Self {
        let app_database_path =
            crate::host::service::configuration::AppServiceConfiguration::capture(&data_root)
                .db_path;
        let source = Arc::new(BriefingSource {
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

    pub(in crate::host) async fn generate(
        &self,
        run_id: &str,
        now: DateTime<Utc>,
        cancellation: &CancellationToken,
    ) -> Result<Map<String, Value>, BriefingGenerationError> {
        self.generator.generate(run_id, now, cancellation).await
    }

    pub(in crate::host) async fn close(&self) {
        if self.owns_profile_and_ledger {
            self.profile.close().await;
            self.ledger.close().await;
        }
    }

    pub(in crate::host) fn profile(&self) -> Arc<ProfileService> {
        self.profile.clone()
    }
}

impl BriefingInputSource for BriefingSource {
    fn local_minute(&self, epoch_ms: i64) -> Result<u16, BriefingGenerationError> {
        self.date_parser
            .local_day_and_minute(epoch_ms)
            .map(|(_, minute)| minute)
            .map_err(|failure| {
                BriefingGenerationError::new(
                    BriefingGenerationCode::NewChatBriefingTimeFailed,
                    failure.message(),
                )
                .with_source(failure)
            })
    }
    fn snapshot(&self) -> BriefingInputFuture<'_> {
        Box::pin(async move {
            let read = self.models.read().await.map_err(|failure| {
                BriefingGenerationError::new(
                    BriefingGenerationCode::NewChatBriefingSettingsFailed,
                    failure.to_string(),
                )
                .with_source(failure)
            })?;
            let app_path = self.app_database_path.clone();
            let app_settings =
                tokio::task::spawn_blocking(move || read_new_chat_briefing_settings(&app_path))
                    .await
                    .map_err(|source| {
                        BriefingGenerationError::new(
                            BriefingGenerationCode::NewChatBriefingAppReadFailed,
                            "App briefing read worker failed",
                        )
                        .with_source(source)
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
                        BriefingGenerationCode::NewChatBriefingProfileFailed,
                        failure.message(),
                    )
                    .with_source(failure)
                })?;
            let app_path = self.app_database_path.clone();
            let app_projects =
                tokio::task::spawn_blocking(move || read_new_chat_briefing_projects(&app_path))
                    .await
                    .map_err(|source| {
                        BriefingGenerationError::new(
                            BriefingGenerationCode::NewChatBriefingAppReadFailed,
                            "App project read worker failed",
                        )
                        .with_source(source)
                    })?
                    .map_err(|source| {
                        BriefingGenerationError::new(
                            BriefingGenerationCode::NewChatBriefingAppReadFailed,
                            "App project snapshot could not be read",
                        )
                        .with_source(source)
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
                        BriefingGenerationCode::NewChatBriefingLedgerFailed,
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
    catalog: &butler_models::models::ModelCatalogSnapshot,
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
    let selected = butler_models::models::parse_model_ref(selected);
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

fn setup(error: impl std::error::Error + Send + Sync + 'static) -> BtccError {
    BtccError::relayed("new_chat_briefing_setup_failed", error.to_string()).with_source(error)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{locale_preference, model_preference, reasoning_preference};

    #[test]
    fn briefing_model_locale_and_effort_follow_configured_priority() {
        {
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
        {
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
}
