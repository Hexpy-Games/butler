//! Source App gateway startup facts; HTTP and process ownership remain with the host.

use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;
use serde_json::Value;

use butler_core::json::number_from_string;
use butler_core::public_text::trim_js_whitespace;
use butler_gateway::gateway::{GatewayConfig, LocalAuthConfig};

use super::local_credentials::{CredentialFiles, LocalCredentialError, LocalCredentials};

const MAX_SIGNED_URL_TTL_SECONDS: u64 = 600;

pub(crate) struct AppServiceConfiguration {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) db_path: PathBuf,
    pub(crate) db_configured: bool,
    pub(crate) enabled: bool,
    pub(crate) folder_selection_secret: Option<String>,
    gateway: GatewayConfig,
    /// Why the token or the folder secret is unavailable; the gateway then
    /// refuses every client (`local_auth_unconfigured`).
    credential_errors: Vec<LocalCredentialError>,
}

/// The typed part of `gateways/app.json` `config`. Each field is read on
/// its own, so one malformed field does not discard the others.
#[derive(Default)]
struct TypedGatewaySettings {
    /// `allowedHosts`: extra Host names (`name` or `name:port`) the gateway
    /// answers besides loopback. A list that is not all strings is ignored
    /// as a whole.
    allowed_hosts: Vec<String>,
    /// `remoteAccessEnabled`: also listen on the LAN (Settings → Security).
    remote_access_enabled: bool,
}

impl TypedGatewaySettings {
    fn read(config: Option<&Value>) -> Self {
        let Some(config) = config else {
            return Self::default();
        };
        Self {
            allowed_hosts: config
                .get("allowedHosts")
                .and_then(|value| Vec::<String>::deserialize(value).ok())
                .unwrap_or_default(),
            remote_access_enabled: config
                .get("remoteAccessEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }
}

/// Facts captured by the process that cannot safely change with an App-only
/// listener restart because the App runtime owners are already constructed.
pub(crate) struct AppCapturedDependencies {
    db_path: PathBuf,
    folder_selection_secret: Option<String>,
    /// The process's token: every gateway it starts shares it, so a rotated
    /// connection code (which rewrites the token file too) still matches.
    local_auth: LocalAuthConfig,
}

impl AppCapturedDependencies {
    pub(crate) fn capture(configuration: &AppServiceConfiguration) -> Self {
        Self {
            db_path: configuration.db_path.clone(),
            folder_selection_secret: configuration.folder_selection_secret.clone(),
            local_auth: configuration.gateway.local_auth.clone(),
        }
    }

    pub(crate) fn matches(&self, configuration: &AppServiceConfiguration) -> bool {
        let local_auth = &configuration.gateway.local_auth;
        self.db_path == configuration.db_path
            && self.folder_selection_secret == configuration.folder_selection_secret
            && self.local_auth.required == local_auth.required
            && self.local_auth.token() == local_auth.token()
    }

    /// The token the process's gateways use.
    pub(crate) fn local_auth(&self) -> LocalAuthConfig {
        self.local_auth.clone()
    }
}

impl AppServiceConfiguration {
    /// The App gateway facts of `data_root`; credential files are only read.
    pub(crate) fn capture(data_root: &Path) -> Self {
        Self::capture_with(data_root, CredentialFiles::ReadOnly)
    }

    /// The same, creating missing credential files when `files` allows.
    pub(crate) fn capture_with(data_root: &Path, files: CredentialFiles) -> Self {
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
        // Local auth is enforced whoever started the agent: the token (and
        // the folder secret) belong to the data folder.
        let LocalCredentials {
            token,
            folder_secret,
            admin,
        } = LocalCredentials::load(data_root, files);
        let mut credential_errors = Vec::new();
        let token = token.map_err(|error| credential_errors.push(error)).ok();
        let folder_secret = folder_secret
            .map_err(|error| credential_errors.push(error))
            .ok();
        Self {
            host,
            port,
            db_path,
            db_configured,
            enabled,
            folder_selection_secret: folder_secret,
            gateway: gateway_config(
                LocalAuthConfig::required(token),
                TypedGatewaySettings::read(config),
                admin.ok(),
            ),
            credential_errors,
        }
    }

    /// Why the data folder's gateway token or folder secret could not be
    /// read or created (empty when both are available).
    pub(crate) fn credential_errors(&self) -> &[LocalCredentialError] {
        &self.credential_errors
    }

    /// `config.allowedHosts`: extra host names (tunnels, reverse proxies).
    pub(crate) fn allowed_hosts(&self) -> &[String] {
        &self.gateway.allowed_hosts
    }

    /// The local admin credential (`app/runtime/auth/local-admin.json`),
    /// when it exists; Settings → Security requires it.
    pub(crate) fn admin_credential(&self) -> Option<&str> {
        self.gateway.admin_credential.as_deref()
    }

    /// `config.remoteAccessEnabled`: also listen on the LAN.
    pub(crate) fn remote_access_enabled(&self) -> bool {
        self.gateway.remote_access_enabled
    }

    pub(crate) fn gateway_config(&self) -> GatewayConfig {
        GatewayConfig {
            local_auth: self.gateway.local_auth.clone(),
            dev_cors_origin: self.gateway.dev_cors_origin.clone(),
            allowed_hosts: self.gateway.allowed_hosts.clone(),
            remote_access_enabled: self.gateway.remote_access_enabled,
            admin_credential: self.gateway.admin_credential.clone(),
            security_store: self.gateway.security_store.clone(),
            signed_url_ttl: self.gateway.signed_url_ttl,
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
            butler_core::json::saturating_u16(value)
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

fn gateway_config(
    local_auth: LocalAuthConfig,
    settings: TypedGatewaySettings,
    admin_credential: Option<String>,
) -> GatewayConfig {
    let max = env::var("BUTLER_APP_SERVER_MESSAGE_RATE_LIMIT_MAX")
        .map(|value| number_from_string(&value))
        .unwrap_or(60.0);
    let window_ms = env::var("BUTLER_APP_SERVER_MESSAGE_RATE_LIMIT_WINDOW_MS")
        .map(|value| number_from_string(&value))
        .unwrap_or(60_000.0);
    GatewayConfig {
        local_auth,
        dev_cors_origin: env::var("BUTLER_APP_DEV_ORIGIN").ok(),
        allowed_hosts: settings
            .allowed_hosts
            .into_iter()
            .map(|name| trim_js_whitespace(&name).to_owned())
            .filter(|name| !name.is_empty())
            .collect(),
        remote_access_enabled: settings.remote_access_enabled,
        admin_credential,
        security_store: None,
        signed_url_ttl: signed_url_ttl(),
        message_rate_limit_max: if max.is_finite() && max > 0.0 {
            butler_core::json::saturating_u64(max.ceil())
        } else {
            60
        },
        message_rate_limit_window: if window_ms.is_finite() && window_ms > 0.0 {
            Duration::try_from_secs_f64(window_ms / 1000.0).unwrap_or(Duration::MAX)
        } else {
            Duration::from_secs(60)
        },
        static_ui_root: None,
    }
}

/// `BUTLER_APP_SIGNED_URL_TTL_SECONDS` may only shorten the 10-minute
/// lifetime of signed message-file URLs.
fn signed_url_ttl() -> Duration {
    let seconds = env::var("BUTLER_APP_SIGNED_URL_TTL_SECONDS")
        .map(|value| number_from_string(&value))
        .ok()
        .filter(|seconds| seconds.is_finite() && *seconds >= 1.0)
        .map_or(MAX_SIGNED_URL_TTL_SECONDS, |seconds| {
            butler_core::json::saturating_u64(seconds.floor()).min(MAX_SIGNED_URL_TTL_SECONDS)
        });
    Duration::from_secs(seconds)
}
