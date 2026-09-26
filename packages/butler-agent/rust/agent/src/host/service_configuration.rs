//! Source native-Butler startup facts and the one default-session binding.

mod app;
mod session;

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::installation::ResolvedInstallation;
use crate::btcc::BtccError;
use crate::models::{DEFAULT_MODEL_REF, parse_model_ref};
use crate::workspace::StoredSessionBinding;

pub(crate) use app::{NativeAppCapturedDependencies, NativeAppServiceConfiguration};

pub(crate) struct NativeServiceBootstrap {
    pub(crate) binding: StoredSessionBinding,
    /// Only a new registration emits source's session_status event.
    pub(crate) newly_registered: bool,
}

pub(crate) struct NativeServiceConfiguration {
    pub(crate) app: NativeAppServiceConfiguration,
    pub(crate) installation: ResolvedInstallation,
    pub(crate) data_root: PathBuf,
    pub(crate) provider_id: String,
    default_binding_model_ref: String,
    user_home: PathBuf,
    projects: Vec<(String, String)>,
}

impl NativeServiceConfiguration {
    pub(crate) fn capture(
        explicit_data: Option<&str>,
        user_home: &Path,
        installation: &ResolvedInstallation,
    ) -> Result<Self, BtccError> {
        let requested_data =
            source_path(explicit_data, "BUTLER_DATA").unwrap_or_else(|| user_home.join(".butler"));
        let data_root = installation
            .validate_data_root(&requested_data)
            .map_err(|message| BtccError::relayed("native_path_configuration_invalid", message))?;
        let config = read_butler_config(&data_root);
        let configured = source_model(&config).unwrap_or("");
        let provider_model = if crate::public_text::trim_js_whitespace(configured).is_empty() {
            DEFAULT_MODEL_REF
        } else {
            configured
        };
        let provider_id = parse_model_ref(provider_model).provider_id;
        if !matches!(
            provider_id.as_str(),
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
            return Err(BtccError::relayed(
                "provider_adapter_not_registered",
                format!("provider_adapter_not_registered:{provider_id}"),
            ));
        }
        let fallback_model = source_model(&config).unwrap_or("openai/gpt-5.5-codex");
        let default_binding_model_ref = if fallback_model.contains('/') {
            fallback_model.to_owned()
        } else {
            format!("{provider_id}/{fallback_model}")
        };
        let projects = config
            .get("projects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|project| {
                Some((
                    project.get("path")?.as_str()?.to_owned(),
                    project.get("name")?.as_str()?.to_owned(),
                ))
            })
            .collect();
        let app = NativeAppServiceConfiguration::capture(&data_root);
        Ok(Self {
            app,
            installation: installation.clone(),
            data_root,
            provider_id,
            default_binding_model_ref,
            user_home: user_home.to_path_buf(),
            projects,
        })
    }

    pub(super) fn validate_workspace(&self, workspace: &Path) -> Result<(), BtccError> {
        self.installation
            .validate_workspace_root(workspace)
            .map_err(|message| {
                BtccError::relayed("native_workspace_configuration_invalid", message)
            })
    }
}

/// The queued app Turn must use the binding persisted at startup, including a
/// model restored from an existing session rather than the current config.
pub(crate) fn require_model_ref(binding: &StoredSessionBinding) -> Result<&str, BtccError> {
    let value = binding.model_ref.as_str();
    if crate::public_text::trim_js_whitespace(value).is_empty() {
        return Err(BtccError::relayed(
            "butler_model_binding_missing",
            "Stored Butler session has no model binding",
        ));
    }
    if !value.contains('/') {
        return Err(BtccError::relayed(
            "butler_model_binding_not_canonical",
            "Stored Butler model binding is not canonical",
        ));
    }
    Ok(value)
}

fn source_path(explicit: Option<&str>, name: &str) -> Option<PathBuf> {
    explicit
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
}

fn read_butler_config(data_root: &Path) -> Value {
    std::fs::read(data_root.join("butler.config.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

fn source_model(config: &Value) -> Option<&str> {
    ["/system/butlerModel", "/system/defaultModel"]
        .into_iter()
        .filter_map(|pointer| config.pointer(pointer).and_then(Value::as_str))
        .find(|value| !value.is_empty())
}
