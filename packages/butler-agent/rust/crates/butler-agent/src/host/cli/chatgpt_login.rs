//! CLI wrapper around the same ChatGPT attempt as the App.
use crate::host::{HostError, ResolvedInstallation, chatgpt_sign_in::Attempt};
use butler_models::models::{self, chatgpt::SignInKind};
use butler_platform::{desktop, process_control};
use std::{io::Write, path::PathBuf};
use tokio_util::sync::CancellationToken;

pub(crate) async fn run(
    installation: ResolvedInstallation,
    requested: PathBuf,
    new_account: bool,
) -> Result<(), HostError> {
    let data = tokio::task::spawn_blocking(move || installation.validate_data_root(&requested))
        .await
        .map_err(HostError::from_error)??;
    super::http_logs::prepare(&data);
    let owner = open_auth_models(data).await?;
    let configuration = owner.configuration.clone();
    let kind = if new_account {
        SignInKind::NewAccount
    } else {
        SignInKind::Default
    };
    let attempt = Attempt::start(&configuration, kind)
        .await
        .map_err(HostError::from)?;
    println!("{}", attempt.auth_url);
    std::io::stdout().flush().map_err(HostError::from_error)?;
    if !configuration.chatgpt_no_browser() && desktop::has_display() {
        let _ = open_browser(&attempt.auth_url).await?;
    }
    let stop = CancellationToken::new();
    let stopped = stop.clone();
    let signal = tokio::spawn(async move {
        cancellation().await;
        stopped.cancel();
    });
    let outcome = attempt.run(configuration, stop, || true).await;
    signal.abort();
    let outcome = outcome.map_err(HostError::from)?;
    println!(
        "Signed in: {} (plan {}).",
        outcome.label,
        if outcome.plan_enabled { "on" } else { "off" }
    );
    Ok(())
}

/// Auth commands share persisted quota ownership with the running App.
pub(super) async fn open_auth_models(data: PathBuf) -> Result<models::StatusModels, HostError> {
    let owner = models::open_status_models(data.clone())
        .await
        .map_err(HostError::from_error)?;
    let quota = tokio::task::spawn_blocking(move || {
        butler_runtime::operations::ProviderQuotaStore::open(
            &data,
            std::sync::Arc::new(crate::host::SystemIdentity),
        )
    })
    .await
    .map_err(HostError::from_error)?;
    owner
        .configuration
        .set_provider_quota_sink(std::sync::Arc::new(quota));
    Ok(owner)
}

async fn open_browser(url: &str) -> Result<bool, crate::host::HostError> {
    let Some(command) = desktop::open_url(url) else {
        return Ok(false);
    };
    let Ok(mut child) = tokio::process::Command::from(command)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return Ok(false);
    };
    let result = tokio::select! {
        result = child.wait() => Some(Ok(result.is_ok_and(|status| status.success()))),
        () = cancellation() => Some(Err("OAuth login cancelled".into())),
        () = tokio::time::sleep(std::time::Duration::from_secs(3)) => None,
    };
    if let Some(Ok(opened)) = &result {
        return Ok(*opened);
    }
    let _ = child.kill().await;
    result.unwrap_or(Ok(false))
}

/// Resolves at the host's first stop request (SIGTERM or SIGINT on Unix,
/// console control events on Windows). A listener that cannot be installed
/// never cancels.
async fn cancellation() {
    match process_control::shutdown_requests() {
        Ok(mut requests) => {
            requests.recv().await;
        }
        Err(_) => std::future::pending().await,
    }
}
