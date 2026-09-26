//! Narrow owner for DATA/gateways/app.json projections and persist-only patches.

use std::{
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value, json};

use crate::host::{ResolvedInstallation, service_configuration::NativeAppServiceConfiguration};

pub(super) struct Settings {
    value: Value,
}

impl Settings {
    pub(super) fn read(
        data_root: &Path,
        installation: &ResolvedInstallation,
    ) -> Result<Self, String> {
        let path = settings_path(data_root);
        installation
            .validate_data_root(&path)
            .map_err(|_| "native_path_configuration_invalid".to_owned())?;
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err("gateway_settings_path_ambiguous".into());
        }
        let value = crate::configuration::read_json_object(&path)
            .map_err(|message| format!("gateway_settings_read_failed: {message}"))?;
        Ok(Self { value })
    }

    pub(super) fn enabled(&self) -> bool {
        self.value["enabled"].as_bool().unwrap_or(true)
    }

    pub(super) fn updated(&self) -> bool {
        self.value["updatedAt"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    }

    pub(super) async fn patch(
        &mut self,
        data_root: &Path,
        installation: &ResolvedInstallation,
        enabled: Option<bool>,
        config_patch: Map<String, Value>,
    ) -> Result<(), String> {
        let writes = crate::configuration::ConfigurationWrites::new();
        let _permit = writes.acquire().await;
        let current = Self::read(data_root, installation)?;
        let existing_config = current.value["config"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut config = existing_config;
        config.extend(config_patch);
        let next_enabled = enabled.or_else(|| current.value["enabled"].as_bool());
        let mut next = current.value.as_object().cloned().unwrap_or_default();
        next.insert("id".into(), Value::String("app".into()));
        if let Some(enabled) = next_enabled {
            next.insert("enabled".into(), Value::Bool(enabled));
        } else {
            next.remove("enabled");
        }
        next.insert("config".into(), Value::Object(config));
        next.insert(
            "updatedAt".into(),
            Value::String(crate::models::ModelConfigurationClock::now_iso(
                &crate::host::SystemIdentity,
            )),
        );
        let next = Value::Object(next);
        write_settings(data_root, installation, &next)?;
        self.value = next;
        Ok(())
    }
}

pub(super) fn local_view(
    settings: &Settings,
    app: &NativeAppServiceConfiguration,
    running: bool,
    restart_required: bool,
) -> Value {
    let enabled = settings.enabled();
    let status = if !enabled {
        "disabled"
    } else if running {
        "online"
    } else {
        "offline"
    };
    let next_actions = if !enabled {
        vec!["butler gateway enable app"]
    } else if running {
        vec!["butler gateway status app"]
    } else {
        vec!["butler gateway start app"]
    };
    json!({
        "id":"app",
        "title":"Butler App Gateway",
        "lifecycle":"process",
        "transport":"app",
        "enabled":enabled,
        "configured":!app.host.is_empty() && app.port > 0,
        "running":running,
        "status":status,
        "restartRequired":restart_required,
        "credentials":{},
        "config":{
            "host":app.host,
            "port":app.port,
            "serverUrl":format!("http://{}:{}", app.host, app.port),
            "dbConfigured":app.db_configured,
        },
        "nextActions":next_actions,
    })
}

fn write_settings(
    data_root: &Path,
    installation: &ResolvedInstallation,
    value: &Value,
) -> Result<(), String> {
    let path = settings_path(data_root);
    let parent = path
        .parent()
        .ok_or_else(|| "gateway_settings_path_invalid".to_owned())?;
    installation
        .validate_data_root(&path)
        .map_err(|_| "native_path_configuration_invalid".to_owned())?;
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
        .map_err(|_| "gateway_settings_unavailable".to_owned())?;
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("gateway_settings_path_ambiguous".into());
    }
    installation
        .validate_data_root(parent)
        .map_err(|_| "native_path_configuration_invalid".to_owned())?;
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("gateway_settings_path_ambiguous".into());
    }
    crate::configuration::write_json_atomic(&path, value)
        .map_err(|_| "gateway_settings_unavailable".to_owned())
}

fn settings_path(data_root: &Path) -> PathBuf {
    data_root.join("gateways/app.json")
}
