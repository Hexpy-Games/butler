//! Source App gateway startup facts; HTTP and process ownership remain with the host.

use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::Value;

use crate::{
    gateway::{GatewayConfig, LocalAuthConfig},
    json::number_from_string,
    public_text::trim_js_whitespace,
};

pub(crate) struct NativeAppServiceConfiguration {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) db_path: PathBuf,
    pub(crate) db_configured: bool,
    pub(crate) enabled: bool,
    pub(crate) folder_selection_secret: Option<String>,
    gateway: GatewayConfig,
}

/// Facts captured by the process that cannot safely change with an App-only
/// listener restart because the App runtime owners are already constructed.
pub(crate) struct NativeAppCapturedDependencies {
    db_path: PathBuf,
    folder_selection_secret: Option<String>,
    local_auth_required: bool,
    local_auth_token: Option<String>,
}

impl NativeAppCapturedDependencies {
    pub(crate) fn capture(configuration: &NativeAppServiceConfiguration) -> Self {
        let local_auth = &configuration.gateway.local_auth;
        Self {
            db_path: configuration.db_path.clone(),
            folder_selection_secret: configuration.folder_selection_secret.clone(),
            local_auth_required: local_auth.required,
            local_auth_token: local_auth.token().map(str::to_owned),
        }
    }

    pub(crate) fn matches(&self, configuration: &NativeAppServiceConfiguration) -> bool {
        let local_auth = &configuration.gateway.local_auth;
        self.db_path == configuration.db_path
            && self.folder_selection_secret == configuration.folder_selection_secret
            && self.local_auth_required == local_auth.required
            && self.local_auth_token.as_deref() == local_auth.token()
    }
}

impl NativeAppServiceConfiguration {
    pub(crate) fn capture(data_root: &Path) -> Self {
        let settings = fs::read(data_root.join("gateways/app.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or(Value::Null);
        let config = settings.get("config").filter(|value| value.is_object());
        let enabled = env::var("BUTLER_APP_BUNDLED_SUPERVISOR").as_deref() == Ok("1")
            || settings
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
        let host = env_trimmed("BUTLER_APP_SERVER_HOST")
            .or_else(|| {
                config
                    .and_then(|value| trimmed_string(value.get("host")))
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "127.0.0.1".to_owned());
        let env_port = env::var("BUTLER_APP_SERVER_PORT").ok();
        let cli_port = argv_port();
        let port = normalize_port(
            env_port
                .as_deref()
                .map(number_from_string)
                .or(cli_port)
                .or_else(|| config.and_then(|value| number_value(value.get("port")))),
        );
        let configured_db = env_trimmed("BUTLER_APP_SERVER_DB").or_else(|| {
            config
                .and_then(|value| trimmed_string(value.get("dbPath")))
                .map(str::to_owned)
        });
        let db_configured = configured_db.is_some();
        let db_path = configured_db
            .map(PathBuf::from)
            .unwrap_or_else(|| data_root.join("app-server/butler-client.sqlite"));
        let max = env::var("BUTLER_APP_SERVER_MESSAGE_RATE_LIMIT_MAX")
            .map(|value| number_from_string(&value))
            .unwrap_or(60.0);
        let window_ms = env::var("BUTLER_APP_SERVER_MESSAGE_RATE_LIMIT_WINDOW_MS")
            .map(|value| number_from_string(&value))
            .unwrap_or(60_000.0);
        let gateway = GatewayConfig {
            local_auth: local_auth(),
            dev_cors_origin: env::var("BUTLER_APP_DEV_ORIGIN").ok(),
            message_rate_limit_max: if max.is_finite() && max > 0.0 {
                crate::json::saturating_u64(max.ceil())
            } else {
                60
            },
            message_rate_limit_window: if window_ms.is_finite() && window_ms > 0.0 {
                Duration::try_from_secs_f64(window_ms / 1000.0).unwrap_or(Duration::MAX)
            } else {
                Duration::from_secs(60)
            },
            static_ui_root: None,
        };
        Self {
            host,
            port,
            db_path,
            db_configured,
            enabled,
            folder_selection_secret: env::var("BUTLER_PROJECT_FOLDER_TOKEN_SECRET").ok(),
            gateway,
        }
    }

    pub(crate) fn gateway_config(&self) -> GatewayConfig {
        GatewayConfig {
            local_auth: self.gateway.local_auth.clone(),
            dev_cors_origin: self.gateway.dev_cors_origin.clone(),
            message_rate_limit_max: self.gateway.message_rate_limit_max,
            message_rate_limit_window: self.gateway.message_rate_limit_window,
            static_ui_root: self.gateway.static_ui_root.clone(),
        }
    }
}

fn env_trimmed(name: &str) -> Option<String> {
    env::var(name).ok().and_then(|value| {
        let value = trim_js_whitespace(&value);
        (!value.is_empty()).then(|| value.to_owned())
    })
}

fn trimmed_string(value: Option<&Value>) -> Option<&str> {
    let value = value?.as_str().map(trim_js_whitespace)?;
    (!value.is_empty()).then_some(value)
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(value) => value.as_f64().filter(|number| number.is_finite()),
        Value::String(value) if !trim_js_whitespace(value).is_empty() => {
            let number = number_from_string(value);
            number.is_finite().then_some(number)
        }
        _ => None,
    }
}

fn normalize_port(value: Option<f64>) -> u16 {
    match value {
        Some(value) if value.is_finite() && (1.0..=65_535.0).contains(&value) => {
            crate::json::saturating_u16(value)
        }
        _ => 18_765,
    }
}

fn argv_port() -> Option<f64> {
    env::args_os()
        .filter_map(|arg| arg.into_string().ok())
        .find_map(|arg| {
            arg.strip_prefix("--port=")
                .map(|tail| number_from_string(tail.split('=').next().unwrap_or("")))
        })
        .filter(|value| value.is_finite())
}

fn local_auth() -> LocalAuthConfig {
    if env::var("BUTLER_APP_LOCAL_AUTH_REQUIRED").as_deref() != Ok("1") {
        return LocalAuthConfig::default();
    }
    let token = env_trimmed("BUTLER_APP_LOCAL_AUTH_FILE")
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("token")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    LocalAuthConfig::required(token)
}
