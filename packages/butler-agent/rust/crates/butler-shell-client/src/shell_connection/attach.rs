use crate::{AttachState, Error, ShellClient};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use butler_platform::instance::{process_executable, process_start, same_executable};
use butler_platform::process_control::{Liveness, liveness};
use hmac::{Hmac, Mac as _};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::path::{Path, PathBuf};

const INSTANCE: &str = "state/butler-agent-native-service.json";

#[derive(Deserialize)]
struct Instance {
    schema: String,
    nonce: String,
    pid: u32,
    process_start: String,
    executable: String,
    state: String,
    app_enabled: bool,
    app_endpoint: Option<String>,
}
#[derive(Deserialize)]
struct Auth {
    token: String,
}
/// `app/runtime/auth/local-admin.json` (`APP_LOCAL_ADMIN_FILE`); no Debug, so the secret never
/// reaches a log line.
#[derive(Deserialize)]
struct LocalAdmin {
    schema: String,
    secret: String,
}
const LOCAL_ADMIN: [&str; 4] = ["app", "runtime", "auth", "local-admin.json"];
const LOCAL_ADMIN_SCHEMA: &str = "butler.app-local-admin.v1";
/// Shorter secrets count as missing, as in the agent (`APP_LOCAL_ADMIN_MIN_LENGTH`).
const LOCAL_ADMIN_MIN_LENGTH: usize = 32;

/// `projectFolderTokenTtlMs`
const FOLDER_TOKEN_TTL_MS: u128 = 5 * 60 * 1000;
/// The token body, in Electron's key order; the signature covers its base64url text.
#[derive(Serialize)]
struct FolderPayload<'a> {
    path: &'a str,
    issued_at: u128,
    expires_at: u128,
}

impl ShellClient {
    /// Stable attachment identity, excluding credentials.
    pub fn instance_identity(&self) -> &(u32, String, String) {
        &self.inner.identity
    }

    /// A folder-selection token for `path` (`v1.<b64url payload>.<b64url HMAC-SHA256>`),
    /// signed with the data folder's secret, which is read on each call and never kept.
    pub fn folder_selection_token(&self, path: &Path) -> Result<String, Error> {
        let secret = read_folder_secret(&self.inner.data)?;
        let path = std::path::absolute(path).map_err(|_| Error::LocalMetadata)?;
        let issued_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::LocalMetadata)?
            .as_millis();
        let payload = serde_json::to_vec(&FolderPayload {
            path: path.to_str().ok_or(Error::LocalMetadata)?,
            issued_at,
            expires_at: issued_at + FOLDER_TOKEN_TTL_MS,
        })
        .map_err(|_| Error::LocalMetadata)?;
        let payload = URL_SAFE_NO_PAD.encode(payload);
        let mut mac =
            Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| Error::LocalMetadata)?;
        mac.update(payload.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        Ok(format!("v1.{payload}.{signature}"))
    }

    pub(super) async fn instance_alive(&self) -> bool {
        matches!(Self::attach(Some(self.inner.data.clone())).await,
            Ok(AttachState::Connected(client)) if client.instance_identity() == self.instance_identity())
    }

    /// Attach using explicit DATA, then BUTLER_DATA, then the platform home's
    /// `.butler` directory. Reads only metadata and never starts an agent.
    pub async fn attach(data: Option<PathBuf>) -> Result<AttachState, Error> {
        // Client construction may also read the platform certificate store.
        tokio::task::spawn_blocking(move || {
            let Some((data, endpoint, token, identity)) = discover(data)? else {
                return Ok(AttachState::NotRunning);
            };
            Ok(AttachState::Connected(Self::new(
                data, endpoint, token, identity,
            )?))
        })
        .await
        .map_err(|_| Error::LocalMetadata)?
    }
}

type Discovery = Option<(PathBuf, reqwest::Url, String, (u32, String, String))>;
fn discover(data: Option<PathBuf>) -> Result<Discovery, Error> {
    let data = data
        .or_else(|| {
            std::env::var_os("BUTLER_DATA")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| butler_platform::user_dirs::non_empty_home_dir().map(|p| p.join(".butler")))
        .ok_or(Error::LocalMetadata)?;
    let record: Instance = match std::fs::read(data.join(INSTANCE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(record) => record,
        None => return Ok(None),
    };
    if record.schema != "butler.native-agent-service-instance.v1"
        || record.nonce.trim().is_empty()
        || record.state != "ready"
        || !record.app_enabled
        || record.pid == 0
        || !matches!(liveness(record.pid), Liveness::Running)
        || !identity_matches(&record)
    {
        return Ok(None);
    }
    let Some(endpoint) = record.app_endpoint.as_deref().and_then(local_endpoint) else {
        return Ok(None);
    };
    let token = read_token(&data)?;
    let identity = (record.pid, record.nonce, endpoint.to_string());
    Ok(Some((data, endpoint, token, identity)))
}

fn identity_matches(record: &Instance) -> bool {
    let Ok(Some(start)) = process_start(record.pid) else {
        return false;
    };
    let Ok(Some(executable)) = process_executable(record.pid) else {
        return false;
    };
    !record.executable.is_empty()
        && start == record.process_start
        && same_executable(&record.executable, &executable)
}

fn local_endpoint(value: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(value).ok()?;
    (url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        && url.port_or_known_default().is_some_and(|p| p > 0)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

pub(crate) fn read_token(data: &Path) -> Result<String, Error> {
    let bytes = std::fs::read(data.join(butler_platform::data_paths::LOCAL_AUTH))
        .map_err(|_| Error::LocalMetadata)?;
    let auth: Auth = serde_json::from_slice(&bytes).map_err(|_| Error::LocalMetadata)?;
    if auth.token.trim().is_empty() {
        return Err(Error::LocalMetadata);
    }
    Ok(auth.token)
}

/// The local admin credential (`readAppLocalAdmin`), read on every admin call so a file the agent
/// created later is picked up. Registered as a secret so no log line can carry it.
pub(crate) fn read_admin(data: &Path) -> Result<String, Error> {
    let path = LOCAL_ADMIN
        .iter()
        .fold(data.to_path_buf(), |path, part| path.join(part));
    let bytes = std::fs::read(path).map_err(|_| Error::LocalMetadata)?;
    let admin: LocalAdmin = serde_json::from_slice(&bytes).map_err(|_| Error::LocalMetadata)?;
    let visible = admin.secret.len() >= LOCAL_ADMIN_MIN_LENGTH
        && admin.secret.bytes().all(|b| (0x21..=0x7e).contains(&b));
    if admin.schema != LOCAL_ADMIN_SCHEMA || !visible {
        return Err(Error::LocalMetadata);
    }
    butler_log::register_secret(&admin.secret);
    Ok(admin.secret)
}

/// `resolveProjectFolderTokenSecret`: `BUTLER_PROJECT_FOLDER_TOKEN_SECRET` wins, else the data
/// folder's secret file the Agent created. Registered as a secret so no log line can carry it.
fn read_folder_secret(data: &Path) -> Result<String, Error> {
    let from_env = std::env::var("BUTLER_PROJECT_FOLDER_TOKEN_SECRET")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let secret = match from_env {
        Some(secret) => secret,
        None => std::fs::read_to_string(data.join(butler_platform::data_paths::FOLDER_SECRET))
            .map_err(|_| Error::LocalMetadata)?
            .trim()
            .to_owned(),
    };
    if secret.is_empty() {
        return Err(Error::LocalMetadata);
    }
    butler_log::register_secret(&secret);
    Ok(secret)
}
