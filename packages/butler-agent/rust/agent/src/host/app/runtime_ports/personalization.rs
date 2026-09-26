use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    gateway::{
        AppPersonalizationCommand, AppPersonalizationEvent, AppPersonalizationPort,
        AppPersonalizationResult, ApplicationFuture, GatewayApplicationError,
    },
    host::ResolvedInstallation,
    models::ModelConfiguration,
    profile::{
        ClearProfilingResult, PersonalizationProfileUpdate, ProfileService,
        ProfileThirdPartyImportOptions, ProfilingMode, third_party_migration_prompt,
    },
};

mod errors;
mod paths;
mod projection;
use errors::{invalid_request, model_error, profile_error};
use projection::{event, resolve_response_language, update_event_payload};

pub(crate) struct NativeAppPersonalization {
    profile: Arc<ProfileService>,
    configuration: Arc<ModelConfiguration>,
    installation: ResolvedInstallation,
    data_root: PathBuf,
    response_language_environment: Option<String>,
    clock: Arc<dyn crate::gateway::AppIdentityClock>,
}

impl NativeAppPersonalization {
    pub(crate) fn new(
        profile: Arc<ProfileService>,
        configuration: Arc<ModelConfiguration>,
        installation: ResolvedInstallation,
        data_root: PathBuf,
        clock: Arc<dyn crate::gateway::AppIdentityClock>,
    ) -> Self {
        Self {
            profile,
            configuration,
            installation,
            data_root,
            response_language_environment: std::env::var("BUTLER_RESPONSE_LANGUAGE").ok(),
            clock,
        }
    }

    async fn execute_inner(
        &self,
        command: AppPersonalizationCommand,
        cancellation: CancellationToken,
    ) -> Result<AppPersonalizationResult, GatewayApplicationError> {
        match command {
            AppPersonalizationCommand::Prompt { locale } => Ok(result(
                json!({
                    "locale": locale,
                    "prompt": third_party_migration_prompt(&locale),
                    "raw_profile_included": false
                }),
                None,
            )),
            AppPersonalizationCommand::Read { locale } => {
                Ok(result(self.read_view(&locale).await?, None))
            }
            AppPersonalizationCommand::Update { input } => {
                let event = self.update(input).await?;
                Ok(result(Value::Null, Some(event)))
            }
            AppPersonalizationCommand::Import { input, locale } => {
                self.validate_write_destinations(&input, true)?;
                let object = input.as_object().ok_or_else(invalid_request)?;
                let text = object
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid_request)?
                    .to_owned();
                let source = object
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let model = object
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let imported = self
                    .profile
                    .import_profile_candidates_from_third_party_dump_with_model(
                        ProfileThirdPartyImportOptions {
                            source,
                            text,
                            model,
                            now_epoch_millis: None,
                            cancellation,
                        },
                    )
                    .await
                    .map_err(profile_error)?;
                let event = event(
                    "personalization.profile_imported",
                    &json!({
                        "source": imported.source,
                        "import_id": imported.import_id,
                        "profiling_enabled": imported.profiling_enabled,
                        "model_called": imported.model_called,
                        "imported_candidate_count": imported.imported_candidate_count,
                        "promoted_count": imported.promoted_count,
                        "stable_entry_count": imported.stable_entry_count,
                        "raw_text_included": false
                    }),
                );
                let data = json!({
                    "profiling_enabled": imported.profiling_enabled,
                    "mode": imported.mode,
                    "source": imported.source,
                    "import_id": imported.import_id,
                    "imported_candidate_count": imported.imported_candidate_count,
                    "promoted_count": imported.promoted_count,
                    "skipped_count": imported.skipped_count,
                    "stable_entry_count": imported.stable_entry_count,
                    "projection_written": imported.projection_written,
                    "raw_text_included": false,
                    "model_called": imported.model_called,
                    "fallback_used": false,
                    "personalization": self.read_view(&locale).await?
                });
                Ok(result(data, Some(event)))
            }
        }
    }

    async fn read_view(&self, locale: &str) -> Result<Value, GatewayApplicationError> {
        self.validate_read_destinations()?;
        let documents = self
            .profile
            .read_personalization_documents()
            .await
            .map_err(profile_error)?;
        let profile = self
            .profile
            .read_personalization_profile()
            .await
            .map_err(profile_error)?;
        let consent = self
            .profile
            .read_profiling_consent()
            .await
            .map_err(profile_error)?;
        let extractor = self
            .profile
            .read_extractor_model()
            .await
            .map_err(profile_error)?;
        let user = self
            .configuration
            .read_user_settings()
            .map_err(model_error)?;
        let presets = self
            .profile
            .read_persona_presets(locale)
            .await
            .map_err(profile_error)?;
        let response_language = resolve_response_language(
            user.value.get("responseLanguage").and_then(Value::as_str),
            self.response_language_environment.as_deref(),
            &documents.persona,
        );
        Ok(json!({
            "persona": documents.persona,
            "eol": documents.eol,
            "updated_at": self.clock.now_iso(),
            "response_language": response_language,
            "persona_presets": presets,
            "profile": {
                "butler_nickname": profile.butler_nickname,
                "principal_name": profile.principal_name,
                "preferred_address": profile.preferred_address,
                "updated_at": profile.updated_at,
                "storage_label": "personalization/profile.json"
            },
            "profiling": {
                "mode": consent.mode,
                "enabled": consent.mode != ProfilingMode::Off,
                "consent_version": consent.consent_version,
                "consented_at": consent.consented_at,
                "storage_label": "cognition/profile/profile.sqlite",
                "raw_profile_browser_visible": false,
                "extractor_model": extractor.configured_model.as_deref().unwrap_or("default"),
                "extractor_reasoning_effort": extractor.reasoning_effort,
                "effective_extractor_model": extractor.effective_model,
                "extractor_uses_butler_model": extractor.uses_butler_model
            }
        }))
    }

    async fn update(
        &self,
        input: Value,
    ) -> Result<AppPersonalizationEvent, GatewayApplicationError> {
        let object = input.as_object().ok_or_else(invalid_request)?;
        self.validate_write_destinations(&input, false)?;
        let persona = object
            .get("persona")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let eol = object.get("eol").and_then(Value::as_str).map(str::to_owned);
        if persona.is_some() || eol.is_some() {
            self.profile
                .update_personalization_documents(persona, eol)
                .await
                .map_err(profile_error)?;
        }
        let profile_update = object.get("profile").map(|profile| {
            let profile = profile.as_object();
            PersonalizationProfileUpdate {
                butler_nickname: profile
                    .and_then(|value| value.get("butler_nickname"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                principal_name: profile
                    .and_then(|value| value.get("principal_name"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                preferred_address: profile
                    .and_then(|value| value.get("preferred_address"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }
        });
        if let Some(update) = profile_update {
            self.profile
                .update_personalization_profile(update)
                .await
                .map_err(profile_error)?;
        }
        let profiling = object.get("profiling").and_then(Value::as_object);
        if let Some(mode) = profiling
            .and_then(|value| value.get("mode"))
            .and_then(Value::as_str)
        {
            self.profile
                .set_profiling_mode(ProfilingMode::parse(mode))
                .await
                .map_err(profile_error)?;
        }
        if let Some(model) = profiling
            .and_then(|value| value.get("extractor_model"))
            .and_then(Value::as_str)
        {
            self.profile
                .set_extractor_model(Some(model.to_owned()))
                .await
                .map_err(profile_error)?;
        }
        if let Some(effort) = profiling
            .and_then(|value| value.get("extractor_reasoning_effort"))
            .and_then(Value::as_str)
        {
            self.profile
                .set_extractor_reasoning_effort(Some(effort.to_owned()))
                .await
                .map_err(profile_error)?;
        }
        if let Some(language) = object.get("response_language").and_then(Value::as_str) {
            let _ = self
                .configuration
                .update_user_settings(
                    &json!({"responseLanguage": language}),
                    Some(&self.validated_root()?),
                )
                .await
                .map_err(model_error)?;
        }
        let cleared: Option<ClearProfilingResult> = if profiling
            .and_then(|value| value.get("clear_profile"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            Some(
                self.profile
                    .clear_profiling_data()
                    .await
                    .map_err(profile_error)?,
            )
        } else {
            None
        };
        Ok(event(
            "personalization.updated",
            &Value::Object(update_event_payload(&input, cleared.as_ref())),
        ))
    }
}

impl AppPersonalizationPort for NativeAppPersonalization {
    fn execute(
        &self,
        command: AppPersonalizationCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<AppPersonalizationResult> {
        let this = Self {
            profile: self.profile.clone(),
            configuration: self.configuration.clone(),
            installation: self.installation.clone(),
            data_root: self.data_root.clone(),
            response_language_environment: self.response_language_environment.clone(),
            clock: self.clock.clone(),
        };
        Box::pin(async move { this.execute_inner(command, cancellation).await })
    }
}

fn result(data: Value, event: Option<AppPersonalizationEvent>) -> AppPersonalizationResult {
    AppPersonalizationResult { data, event }
}
