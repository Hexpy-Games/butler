//! Short-lived native Codex OAuth callback child for the desktop login flow.

use std::{io::Write, path::PathBuf, sync::Arc};

use tokio::net::TcpListener;

use butler_platform::{desktop, process_control};

use butler_core::configuration::ConfigurationWrites;
use butler_core::locale::LocaleCollation;
use butler_models::models::{ModelCatalog, ModelConfiguration, provider_http_client};

use crate::host::installation::realpath_or_nearest;
use crate::host::oauth_callback::{Callback, CallbackEndpoint, read_callback, respond};
use crate::host::{ProcessEnvironment, ResolvedInstallation, SystemIdentity};

pub(crate) async fn run_native_oauth_login(
    installation: ResolvedInstallation,
) -> Result<(), crate::host::HostError> {
    let user_home =
        butler_platform::user_dirs::non_empty_home_dir().ok_or("native_home_unavailable")?;
    let requested_data = std::env::var_os("BUTLER_DATA")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".butler"));
    let data_root = installation.validate_data_root(&requested_data)?;
    run_native_oauth_login_with_data(user_home, data_root).await
}

pub(crate) async fn run_native_oauth_login_for_data(
    installation: ResolvedInstallation,
    requested_data: PathBuf,
) -> Result<(), crate::host::HostError> {
    let user_home =
        butler_platform::user_dirs::non_empty_home_dir().ok_or("native_home_unavailable")?;
    let data_root = installation.validate_data_root(&requested_data)?;
    run_native_oauth_login_with_data(user_home, data_root).await
}

async fn run_native_oauth_login_with_data(
    user_home: PathBuf,
    data_root: PathBuf,
) -> Result<(), crate::host::HostError> {
    let os = butler_platform::instance::os_release().map_err(crate::host::HostError::from_error)?;
    let mut environment = ProcessEnvironment::capture(&data_root, &user_home, &os).model;
    let requested_profile = environment
        .butler_codex_auth_profile
        .as_ref()
        .or(environment.butler_openai_auth_profile.as_ref())
        .cloned()
        .unwrap_or_else(|| data_root.join("auth/openai-codex.json"));
    let requested_profile = if requested_profile.is_absolute() {
        requested_profile
    } else {
        data_root.join(requested_profile)
    };
    if tokio::fs::symlink_metadata(&requested_profile)
        .await
        .is_ok()
        && tokio::fs::canonicalize(&requested_profile).await.is_err()
    {
        return Err("OpenAI auth profile path is unavailable".into());
    }
    let profile_path = realpath_or_nearest(&requested_profile).map_err(|source| {
        crate::host::HostError::new("OpenAI auth profile path is unavailable").with_source(source)
    })?;
    if profile_path == data_root || !profile_path.starts_with(&data_root) {
        return Err("OpenAI auth profile path must be inside BUTLER_DATA".into());
    }
    environment.butler_codex_auth_profile = Some(profile_path);
    environment.butler_openai_auth_profile = None;
    let models = ModelConfiguration::new(
        data_root,
        environment,
        Arc::new(SystemIdentity),
        Arc::new(ModelCatalog::new().map_err(crate::host::HostError::from_error)?),
        Arc::new(LocaleCollation::new("en-US").map_err(crate::host::HostError::from_error)?),
        provider_http_client().map_err(crate::host::HostError::from_error)?,
        Arc::new(ConfigurationWrites::new()),
    )
    .map_err(crate::host::HostError::from_error)?;

    let CallbackEndpoint {
        bind_host,
        listen_host,
        port,
        redirect_uri,
    } = CallbackEndpoint::from_environment().map_err(|source| {
        crate::host::HostError::new("OAuth callback port is invalid").with_source(source)
    })?;
    let listener = TcpListener::bind((bind_host.as_str(), port))
        .await
        .map_err(|error| format!("OAuth callback listener failed: {error}"))?;
    let verifier = butler_models::models::generate_pkce_verifier();
    let challenge = butler_models::models::pkce_challenge(&verifier);
    let state = uuid::Uuid::new_v4().simple().to_string();
    let authorize_url = models
        .openai_authorize_url(&redirect_uri, &challenge, &state, None)
        .map_err(crate::host::HostError::from_error)?;
    println!("{authorize_url}");
    println!("Waiting for callback on {redirect_uri}. Press Ctrl+C to cancel.");
    if listen_host == "0.0.0.0" {
        println!(
            "Listening on 0.0.0.0:{port}; publish this port from Docker so your host browser can reach localhost:{port}."
        );
    }
    std::io::stdout()
        .flush()
        .map_err(crate::host::HostError::from_error)?;
    if should_open_browser() {
        let opened = open_browser(authorize_url.as_str()).await?;
        println!(
            "{}",
            if opened {
                "Opening Codex subscription login in your browser."
            } else {
                "Could not open a browser automatically. Open the URL above to continue."
            }
        );
    }

    let callback = async {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(crate::host::HostError::from_error)?;
            let code = match read_callback(&mut stream, &redirect_uri, &state).await {
                Callback::Code(code) => Some(code),
                Callback::Denied => return Err("OAuth authorization denied".into()),
                Callback::Ignored => None,
            };
            if let Some(code) = code {
                let result = models
                    .exchange_openai_oauth_code(&code, &redirect_uri, &verifier)
                    .await;
                match result {
                    Ok(profile) => {
                        if let Err(error) = models.write_openai_auth_profile(&profile).await {
                            respond(&mut stream, 500, "Codex subscription login failed.").await;
                            return Err(crate::host::HostError::from_error(error));
                        }
                        respond(
                            &mut stream,
                            200,
                            "Codex subscription login complete. You can close this tab.",
                        )
                        .await;
                        let raw = profile.as_json();
                        println!(
                            "Codex subscription auth profile saved for {}.",
                            account_label(&raw)
                        );
                        return Ok(());
                    }
                    Err(error) => {
                        respond(&mut stream, 500, "Codex subscription login failed.").await;
                        return Err(crate::host::HostError::from_error(error));
                    }
                }
            }
        }
    };
    tokio::select! {
        result = callback => result,
        () = cancellation() => Err("OAuth login cancelled".into()),
    }
}

/// The signed-in account: its email, else its account id.
fn account_label(profile: &serde_json::Value) -> &str {
    profile
        .get("email")
        .and_then(|value| value.as_str())
        .or_else(|| profile.get("accountId").and_then(|value| value.as_str()))
        .unwrap_or("OpenAI account")
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

fn should_open_browser() -> bool {
    if [
        "BUTLER_CODEX_OAUTH_NO_BROWSER",
        "BUTLER_OPENAI_OAUTH_NO_BROWSER",
    ]
    .iter()
    .any(|name| std::env::var(name).ok().as_deref() == Some("1"))
    {
        return false;
    }
    desktop::has_display()
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
