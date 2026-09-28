//! `butler gateway configure app --allowed-host NAME --remove-allowed-host
//! NAME`: the extra host names the gateway answers, for a tunnel or reverse
//! proxy the user runs in front of it.
//!
//! The list is written to `gateways/app.json` `config.allowedHosts`
//! (atomically, keeping every other field). When the service is running,
//! the change is also sent to its gateway (`PATCH /settings {security}`
//! from this computer, with the local admin credential), which applies it
//! without a restart.

use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value, json};

use butler_gateway::gateway::{ADMIN_CREDENTIAL_HEADER, MAX_ALLOWED_HOSTS, normalize_allowed_host};

use crate::host::ResolvedInstallation;
use crate::host::service::configuration::AppServiceConfiguration;

const LIVE_APPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a service that is still starting is waited for, as `butler open` does.
const STARTING_PATIENCE: Duration = Duration::from_secs(30);

/// The list after adding `added` and removing `removed` (names are
/// validated and compared lower case; entries already stored stay as
/// stored).
pub(super) fn updated(
    current: &[String],
    added: &[String],
    removed: &[String],
) -> Result<Vec<String>, crate::host::HostError> {
    let mut hosts: Vec<String> = current.to_vec();
    for host in added {
        let host =
            normalize_allowed_host(host).map_err(|error| format!("--allowed-host: {error}"))?;
        if !hosts
            .iter()
            .any(|stored| stored.eq_ignore_ascii_case(&host))
        {
            hosts.push(host);
        }
    }
    for host in removed {
        let host = normalize_allowed_host(host)
            .map_err(|error| format!("--remove-allowed-host: {error}"))?;
        hosts.retain(|stored| !stored.trim().eq_ignore_ascii_case(&host));
    }
    if hosts.len() > MAX_ALLOWED_HOSTS {
        return Err(format!("at most {MAX_ALLOWED_HOSTS} allowed hosts are supported").into());
    }
    Ok(hosts)
}

/// Stores `hosts`, then applies them to the running gateway, if any.
/// Returns whether a running gateway took them without a restart.
pub(super) async fn store(
    data_root: &Path,
    installation: &ResolvedInstallation,
    hosts: Vec<String>,
) -> Result<bool, crate::host::HostError> {
    let mut patch = Map::new();
    patch.insert(
        "allowedHosts".into(),
        Value::Array(hosts.iter().cloned().map(Value::String).collect()),
    );
    super::patch_app_config(data_root, installation, patch).await?;
    let Some(endpoint) =
        super::running_app_endpoint(data_root, installation, STARTING_PATIENCE).await?
    else {
        return Ok(false);
    };
    Ok(apply_live(&endpoint, data_root, hosts).await)
}

async fn apply_live(endpoint: &str, data_root: &Path, hosts: Vec<String>) -> bool {
    let app = AppServiceConfiguration::capture(data_root);
    let (Some(token), Some(admin)) = (
        app.gateway_config().local_auth.token(),
        app.admin_credential(),
    ) else {
        return false;
    };
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(LIVE_APPLY_TIMEOUT)
        .build()
    else {
        return false;
    };
    client
        .patch(format!("{endpoint}/settings"))
        .bearer_auth(token)
        .header(ADMIN_CREDENTIAL_HEADER, admin)
        .json(&json!({"security": {"allowed_hosts": hosts}}))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}
