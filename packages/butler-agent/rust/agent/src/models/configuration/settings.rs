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
    pub(crate) async fn read_user_settings(&self) -> Result<ConfigUserSettings, String> {
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
    ) -> Result<ConfigUserSettings, String> {
        let Some(patch) = patch.as_object() else {
            return Err("User settings update is invalid.".into());
        };
        let _write = self.configuration_writes.acquire().await;
        let root = root.unwrap_or(&self.data_root);
        let path = root.join("butler.config.json");
        let mut config = configuration::read_json_object(&path)?;
        let object = config
            .as_object_mut()
            .expect("config reader returns object");
        let user = object
            .entry("user")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if !user.is_object() {
            *user = Value::Object(serde_json::Map::new());
        }
        let user = user.as_object_mut().expect("user settings are an object");
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
    ) -> Result<(), String> {
        let Some(patch) = patch.as_object() else {
            return Err("Web search settings update is invalid.".into());
        };
        let _write = self.configuration_writes.acquire().await;
        let path = root.join("butler.config.json");
        let mut config = configuration::read_json_object(&path)?;
        let object = config
            .as_object_mut()
            .expect("config reader returns object");
        let web_search = object
            .entry("webSearch")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if !web_search.is_object() {
            *web_search = Value::Object(serde_json::Map::new());
        }
        let web_search = web_search.as_object_mut().expect("web search is an object");
        if let Some(value) = patch.get("provider") {
            web_search.insert("provider".into(), value.clone());
        }
        if let Some(value) = patch.get("readerBackend") {
            web_search.insert("readerBackend".into(), value.clone());
        }
        if let Some(planning_patch) = patch.get("planning").and_then(Value::as_object) {
            let planning = web_search
                .entry("planning")
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            if !planning.is_object() {
                *planning = Value::Object(serde_json::Map::new());
            }
            let planning = planning.as_object_mut().expect("planning is an object");
            for (key, value) in planning_patch {
                planning.insert(key.clone(), value.clone());
            }
            planning.remove("mode");
            planning.remove("allowParallelSearch");
            planning.remove("disableSmartForWeakModel");
        }
        configuration::write_json_atomic(&path, &config)
    }

    /// Persist one approved search-provider secret without exposing it through
    /// config or public projections.
    pub(crate) async fn upsert_private_environment_value(
        &self,
        key: &str,
        value: &str,
        root: &Path,
    ) -> Result<(), String> {
        if !matches!(
            key,
            "BUTLER_BRAVE_SEARCH_API_KEY" | "BUTLER_TAVILY_API_KEY" | "OPENAI_API_KEY"
        ) {
            return Err("Private environment key is not supported.".into());
        }
        let _write = self.configuration_writes.acquire().await;
        let path = root.join(".env");
        let original = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(_) => return Err("Private environment file could not be read.".into()),
        };
        let mut lines = original.lines().map(str::to_owned).collect::<Vec<_>>();
        let replacement = format!(
            "{key}={}",
            serde_json::to_string(value).map_err(|_| "Private environment value is invalid.")?
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
        let parent = path
            .parent()
            .ok_or_else(|| "Private environment path is invalid.".to_owned())?;
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
                .map_err(|_| "Private environment directory could not be created.")?;
        }
        #[cfg(not(unix))]
        fs::create_dir_all(parent)
            .map_err(|_| "Private environment directory could not be created.")?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&path)
            .map_err(|_| "Private environment file could not be written.")?;
        file.write_all(format!("{}\n", lines.join("\n")).as_bytes())
            .map_err(|_| "Private environment file could not be written.")?;
        file.sync_all()
            .map_err(|_| "Private environment file could not be written.")?;
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "Private environment file permissions could not be set.")?;
        Ok(())
    }

    pub(crate) async fn set_default_model(
        &self,
        requested: &str,
    ) -> Result<ModelDefaultChange, String> {
        let model = parse_model_ref(requested);
        if model.source != ParsedModelRefSource::Namespaced || model.model_id.is_empty() {
            return Err("model set requires canonical provider/model ref".into());
        }

        let _write = self.configuration_writes.acquire().await;
        let path = self.data_root.join("butler.config.json");
        let mut config = configuration::read_json_object(&path)?;
        let previous = config
            .pointer("/system/defaultModel")
            .cloned()
            .unwrap_or(Value::Null);
        let root = config
            .as_object_mut()
            .expect("configuration reader returns an object");
        let system = root
            .entry("system")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if !system.is_object() {
            *system = Value::Object(serde_json::Map::new());
        }
        let system = system
            .as_object_mut()
            .expect("system configuration is an object");
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
    pub(crate) async fn remove_auth_profile(&self, path: &Path) -> Result<bool, String> {
        let _write = self.configuration_writes.acquire().await;
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("Auth profile could not be inspected.".into()),
            Ok(metadata)
                if metadata.is_dir()
                    || (!metadata.is_file() && !metadata.file_type().is_symlink()) =>
            {
                return Err("Auth profile path is not a file.".into());
            }
            Ok(_) => {}
        }
        std::fs::remove_file(path)
            .map_err(|_| String::from("Auth profile could not be removed."))?;
        Ok(true)
    }
}
