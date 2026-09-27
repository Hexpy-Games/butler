//! Model and authentication mutations exposed by the native settings CLI.

use std::path::Path;
use std::{fs, io::Write};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

use serde_json::Value;

use super::ModelConfiguration;
use crate::{
    configuration,
    models::{ParsedModelRef, ParsedModelRefSource, parse_model_ref},
};

/// Failures of user-settings, default-model, private-environment and
/// auth-profile writes. `Display` is the user-facing message.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SettingsError {
    /// The patch, key or requested model was rejected; the message says why.
    #[error("{0}")]
    Rejected(&'static str),
    /// Reading or writing the shared configuration file failed.
    #[error(transparent)]
    Config(#[from] configuration::ConfigError),
    /// A settings file operation failed; the message names which one.
    #[error("{message}")]
    Io {
        message: &'static str,
        #[source]
        source: std::io::Error,
    },
    /// The private environment value could not be JSON-encoded.
    #[error("Private environment value is invalid.")]
    ValueEncoding(#[source] serde_json::Error),
    /// The blocking private-environment write panicked or was cancelled.
    #[error("Private environment file could not be written.")]
    WriteTask(#[source] tokio::task::JoinError),
}

fn io(message: &'static str) -> impl FnOnce(std::io::Error) -> SettingsError {
    move |source| SettingsError::Io { message, source }
}

pub(crate) struct ModelDefaultChange {
    pub previous: Value,
    pub model: ParsedModelRef,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ConfigUserSettings {
    pub value: Value,
}

impl ModelConfiguration {
    /// Read the current `user` object without initializing DATA or exposing
    /// provider credentials.
    pub(crate) fn read_user_settings(&self) -> Result<ConfigUserSettings, SettingsError> {
        let config = configuration::read_json_object(&self.data_root.join("butler.config.json"))?;
        Ok(ConfigUserSettings {
            value: config
                .get("user")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| Value::Object(serde_json::Map::new())),
        })
    }

    /// Merge source-owned user settings while preserving unknown config keys.
    /// Callers validate the exact DATA destination before reaching this port.
    pub(crate) async fn update_user_settings(
        &self,
        patch: &Value,
        root: Option<&Path>,
    ) -> Result<ConfigUserSettings, SettingsError> {
        let Some(patch) = patch.as_object() else {
            return Err(SettingsError::Rejected("User settings update is invalid."));
        };
        let _write = self.configuration_writes.acquire().await;
        let root = root.unwrap_or(&self.data_root);
        let path = root.join("butler.config.json");
        let mut config = configuration::read_json_object(&path)?;
        let object = crate::json::object_mut(&mut config);
        let user = crate::json::object_field_mut(object, "user");
        for (key, value) in patch {
            user.insert(key.clone(), value.clone());
        }
        let value = Value::Object(user.clone());
        configuration::write_json_atomic(&path, &config)?;
        Ok(ConfigUserSettings { value })
    }

    /// Merge the App-owned web-search fields while retaining unrelated config
    /// and provider-specific settings.
    pub(crate) async fn update_web_search_settings(
        &self,
        patch: &Value,
        root: &Path,
    ) -> Result<(), SettingsError> {
        let Some(patch) = patch.as_object() else {
            return Err(SettingsError::Rejected(
                "Web search settings update is invalid.",
            ));
        };
        let _write = self.configuration_writes.acquire().await;
        let path = root.join("butler.config.json");
        let mut config = configuration::read_json_object(&path)?;
        let object = crate::json::object_mut(&mut config);
        let web_search = crate::json::object_field_mut(object, "webSearch");
        if let Some(value) = patch.get("provider") {
            web_search.insert("provider".into(), value.clone());
        }
        if let Some(value) = patch.get("readerBackend") {
            web_search.insert("readerBackend".into(), value.clone());
        }
        if let Some(planning_patch) = patch.get("planning").and_then(Value::as_object) {
            let planning = crate::json::object_field_mut(web_search, "planning");
            for (key, value) in planning_patch {
                planning.insert(key.clone(), value.clone());
            }
            planning.remove("mode");
            planning.remove("allowParallelSearch");
            planning.remove("disableSmartForWeakModel");
        }
        Ok(configuration::write_json_atomic(&path, &config)?)
    }

    /// Persist one approved search-provider secret without exposing it through
    /// config or public projections.
    pub(crate) async fn upsert_private_environment_value(
        &self,
        key: &str,
        value: &str,
        root: &Path,
    ) -> Result<(), SettingsError> {
        if !matches!(
            key,
            "BUTLER_BRAVE_SEARCH_API_KEY" | "BUTLER_TAVILY_API_KEY" | "OPENAI_API_KEY"
        ) {
            return Err(SettingsError::Rejected(
                "Private environment key is not supported.",
            ));
        }
        let _write = self.configuration_writes.acquire().await;
        let path = root.join(".env");
        let (key, value) = (key.to_owned(), value.to_owned());
        tokio::task::spawn_blocking(move || write_private_environment(&path, &key, &value))
            .await
            .map_err(SettingsError::WriteTask)?
    }

    pub(crate) async fn set_default_model(
        &self,
        requested: &str,
    ) -> Result<ModelDefaultChange, SettingsError> {
        let model = parse_model_ref(requested);
        if model.source != ParsedModelRefSource::Namespaced || model.model_id.is_empty() {
            return Err(SettingsError::Rejected(
                "model set requires canonical provider/model ref",
            ));
        }

        let _write = self.configuration_writes.acquire().await;
        let path = self.data_root.join("butler.config.json");
        let mut config = configuration::read_json_object(&path)?;
        let previous = config
            .pointer("/system/defaultModel")
            .cloned()
            .unwrap_or(Value::Null);
        let root = crate::json::object_mut(&mut config);
        let system = crate::json::object_field_mut(root, "system");
        system.insert(
            "defaultModel".into(),
            Value::String(model.canonical_ref.clone()),
        );
        if model.provider_id == "openai" {
            system.insert("openaiModel".into(), Value::String(model.model_id.clone()));
        }
        configuration::write_json_atomic(&path, &config)?;
        Ok(ModelDefaultChange { previous, model })
    }

    /// Remove only the path selected and validated by the host adapter.
    pub(crate) async fn remove_auth_profile(&self, path: &Path) -> Result<bool, SettingsError> {
        let _write = self.configuration_writes.acquire().await;
        match tokio::fs::symlink_metadata(path).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(source) => {
                return Err(SettingsError::Io {
                    message: "Auth profile could not be inspected.",
                    source,
                });
            }
            Ok(metadata)
                if metadata.is_dir()
                    || (!metadata.is_file() && !metadata.file_type().is_symlink()) =>
            {
                return Err(SettingsError::Rejected("Auth profile path is not a file."));
            }
            Ok(_) => {}
        }
        tokio::fs::remove_file(path)
            .await
            .map_err(io("Auth profile could not be removed."))?;
        Ok(true)
    }
}

/// Replaces or appends `key` in the private `.env` file with owner-only permissions.
fn write_private_environment(path: &Path, key: &str, value: &str) -> Result<(), SettingsError> {
    let original = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(source) => {
            return Err(SettingsError::Io {
                message: "Private environment file could not be read.",
                source,
            });
        }
    };
    let mut lines = original.lines().map(str::to_owned).collect::<Vec<_>>();
    let replacement = format!(
        "{key}={}",
        serde_json::to_string(value).map_err(SettingsError::ValueEncoding)?
    );
    let mut found = false;
    for line in &mut lines {
        if line.starts_with(&format!("{key}=")) {
            *line = replacement.clone();
            found = true;
        }
    }
    if !found {
        lines.push(replacement);
    }
    let parent = path.parent().ok_or(SettingsError::Rejected(
        "Private environment path is invalid.",
    ))?;
    #[cfg(unix)]
    {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(parent)
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists && parent.is_dir() {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(io("Private environment directory could not be created."))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(parent)
        .map_err(io("Private environment directory could not be created."))?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(io("Private environment file could not be written."))?;
    file.write_all(format!("{}\n", lines.join("\n")).as_bytes())
        .map_err(io("Private environment file could not be written."))?;
    file.sync_all()
        .map_err(io("Private environment file could not be written."))?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(io("Private environment file permissions could not be set."))?;
    Ok(())
}
