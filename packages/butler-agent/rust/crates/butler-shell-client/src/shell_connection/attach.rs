use crate::{AttachState, Error, ShellClient};
use butler_platform::instance::{process_executable, process_start, same_executable};
use butler_platform::process_control::{Liveness, liveness};
use serde::Deserialize;
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

impl ShellClient {
    /// Stable attachment identity, excluding credentials.
    pub fn instance_identity(&self) -> &(u32, String, String) {
        &self.inner.identity
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
