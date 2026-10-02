//! First-install defaults. A present reply-language key is a user choice.
use super::{RuntimePaths, boundary::setup};
use crate::host::ResolvedInstallation;
use butler_core::configuration;
use butler_turn::btcc::BtccError;
use serde_json::{Value, json};
use std::path::Path;

pub(super) async fn initialize(
    paths: &RuntimePaths,
    app_database: &Path,
    installation: &ResolvedInstallation,
) -> Result<String, BtccError> {
    let root = paths.data_root.clone();
    let app_database = app_database.to_owned();
    let installation = installation.clone();
    tokio::task::spawn_blocking(move || {
        let root = installation.validate_data_root(&root).map_err(setup)?;
        for relative in [
            "butler.config.json",
            "eol.md",
            "personas",
            "personas/active.md",
        ] {
            let destination = installation
                .validate_data_root(&root.join(relative))
                .map_err(setup)?;
            if !destination.starts_with(&root) {
                return Err(BtccError::relayed(
                    "native_path_configuration_invalid",
                    "Default destination escapes DATA.",
                ));
            }
        }
        let ui =
            butler_gateway::gateway::stored_ui_language_readonly(&app_database).map_err(setup)?;
        initialize_language(&root, ui.as_deref())
    })
    .await
    .map_err(setup)?
}

/// Personalization reads may migrate an automatic fallback after UI language selection.
pub(crate) async fn ensure_reply_language(root: &Path, ui: &str) -> Result<(), BtccError> {
    let root = root.to_owned();
    let ui = ui.to_owned();
    tokio::task::spawn_blocking(move || initialize_language(&root, Some(&ui)).map(|_| ()))
        .await
        .map_err(setup)?
}

fn initialize_language(root: &Path, ui: Option<&str>) -> Result<String, BtccError> {
    let path = root.join("butler.config.json");
    let mut config = configuration::read_json_object(&path).map_err(setup)?;
    if let Some(selected) = stable_language(&config, ui) {
        return Ok(selected);
    }
    let _change = configuration::lock_file(&path).map_err(setup)?;
    config = configuration::read_json_object(&path).map_err(setup)?;
    if let Some(selected) = stable_language(&config, ui) {
        return Ok(selected);
    }
    let user =
        butler_core::json::object_field_mut(butler_core::json::object_mut(&mut config), "user");
    let installer = user
        .get("language")
        .and_then(Value::as_str)
        .and_then(language);
    let os = butler_platform::instance::system_locale();
    // A stored App preference marks an existing install. Its implicit English
    // reply fallback must migrate even if the old installer stored English.
    let existing_korean_ui =
        ui.and_then(language) == Some("ko") && !user.contains_key("responseLanguage");
    let (selected, source) = if existing_korean_ui {
        ("ko", "ui")
    } else if let Some(language) = installer {
        (language, "installer")
    } else if let Some(language) = ui.and_then(language) {
        (language, "ui")
    } else {
        (os.as_deref().and_then(language).unwrap_or("en"), "fallback")
    };
    user.insert("responseLanguage".into(), json!(selected));
    user.insert("responseLanguageDefaultSource".into(), json!(source));
    configuration::write_json_atomic(&path, &config).map_err(setup)?;
    Ok(selected.to_owned())
}

fn stable_language(config: &Value, ui: Option<&str>) -> Option<String> {
    let user = config.get("user")?;
    let selected = user.get("responseLanguage")?;
    let installer = user
        .get("language")
        .and_then(Value::as_str)
        .and_then(language);
    // Only our automatic English fallback can migrate; old present keys are choices.
    if selected.as_str() == Some("en")
        && user
            .get("responseLanguageDefaultSource")
            .and_then(Value::as_str)
            == Some("fallback")
        && (installer == Some("ko") || ui.and_then(language) == Some("ko"))
    {
        return None;
    }
    Some(selected.as_str().unwrap_or("en").to_owned())
}

fn language(value: &str) -> Option<&'static str> {
    match value
        .trim()
        .split(['-', '_'])
        .next()?
        .to_ascii_lowercase()
        .as_str()
    {
        "ko" => Some("ko"),
        "en" => Some("en"),
        _ => None,
    }
}

pub(super) async fn open_profile(
    paths: &RuntimePaths,
    cognition_root: std::path::PathBuf,
    writes: std::sync::Arc<configuration::ConfigurationWrites>,
    coordinator: std::sync::Arc<butler_memory::coordination::CognitionWriteCoordinator>,
    provider: std::sync::Arc<dyn butler_models::models::ProviderPromptPort>,
    language: &str,
) -> Result<std::sync::Arc<butler_memory::profile::ProfileService>, BtccError> {
    use crate::host::{ProfileConversationSources, SystemIdentity};
    use butler_memory::profile::{PersonaPresets, ProfileService};
    use std::sync::Arc;
    let profile = Arc::new(ProfileService::new(
        paths.data_root.clone(),
        cognition_root.clone(),
        Arc::new(PersonaPresets::new(paths.resource_root.clone())),
        writes,
        coordinator,
        Arc::new(SystemIdentity),
        Arc::new(
            ProfileConversationSources::new(butler_turn::conversation::conversation_store_path(
                &paths.data_root,
            ))
            .with_feedback(cognition_root.join("feedback")),
        ),
        provider,
    ));
    profile
        .seed_default_documents(language)
        .await
        .map_err(setup)?;
    Ok(profile)
}
