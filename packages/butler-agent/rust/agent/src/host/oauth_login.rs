//! Short-lived native Codex OAuth callback child for the desktop login flow.

use std::{io::Write, path::PathBuf, sync::Arc};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

use crate::{
    configuration::ConfigurationWrites,
    locale::LocaleCollation,
    models::{ModelCatalog, ModelConfiguration, provider_http_client},
};

use super::installation::realpath_or_nearest;
use super::{NativeProcessEnvironment, ResolvedInstallation, SystemIdentity};

pub async fn run_native_oauth_login(installation: ResolvedInstallation) -> Result<(), String> {
    let user_home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or("native_home_unavailable")?;
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
) -> Result<(), String> {
    let user_home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or("native_home_unavailable")?;
    let data_root = installation.validate_data_root(&requested_data)?;
    run_native_oauth_login_with_data(user_home, data_root).await
}

async fn run_native_oauth_login_with_data(
    user_home: PathBuf,
    data_root: PathBuf,
) -> Result<(), String> {
    let os = nix::sys::utsname::uname().map_err(|error| error.to_string())?;
    let mut environment =
        NativeProcessEnvironment::capture(&data_root, &user_home, &os.release().to_string_lossy())
            .model;
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
    if std::fs::symlink_metadata(&requested_profile).is_ok()
        && requested_profile.canonicalize().is_err()
    {
        return Err("OpenAI auth profile path is unavailable".into());
    }
    let profile_path = realpath_or_nearest(&requested_profile)
        .map_err(|_| "OpenAI auth profile path is unavailable".to_owned())?;
    if profile_path == data_root || !profile_path.starts_with(&data_root) {
        return Err("OpenAI auth profile path must be inside BUTLER_DATA".into());
    }
    environment.butler_codex_auth_profile = Some(profile_path);
    environment.butler_openai_auth_profile = None;
    let models = ModelConfiguration::new(
        data_root,
        environment,
        Arc::new(SystemIdentity),
        Arc::new(ModelCatalog::new().map_err(|error| error.to_string())?),
        Arc::new(LocaleCollation::new("en-US").map_err(|error| error.to_string())?),
        provider_http_client().map_err(|error| error.to_string())?,
        Arc::new(ConfigurationWrites::new()),
    )
    .map_err(|error| error.to_string())?;

    let port = first_env(&["BUTLER_CODEX_OAUTH_PORT", "BUTLER_OPENAI_OAUTH_PORT"])
        .unwrap_or_else(|| "1455".into())
        .parse::<u16>()
        .map_err(|_| "OAuth callback port is invalid".to_owned())?;
    let redirect_uri = first_env(&[
        "BUTLER_CODEX_OAUTH_REDIRECT_URI",
        "BUTLER_OPENAI_OAUTH_REDIRECT_URI",
    ])
    .unwrap_or_else(|| format!("http://localhost:{port}/auth/callback"));
    let listen_host = first_env(&[
        "BUTLER_CODEX_OAUTH_LISTEN_HOST",
        "BUTLER_OPENAI_OAUTH_LISTEN_HOST",
    ])
    .unwrap_or_else(|| {
        if std::path::Path::new("/.dockerenv").exists()
            || std::path::Path::new("/run/.containerenv").exists()
        {
            "0.0.0.0".into()
        } else {
            "localhost".into()
        }
    });
    let bind_host = if listen_host == "localhost" {
        "127.0.0.1"
    } else {
        &listen_host
    };
    let listener = TcpListener::bind((bind_host, port))
        .await
        .map_err(|error| format!("OAuth callback listener failed: {error}"))?;
    let verifier = crate::models::generate_pkce_verifier();
    let challenge = crate::models::pkce_challenge(&verifier);
    let state = uuid::Uuid::new_v4().simple().to_string();
    let authorize_url = models
        .openai_authorize_url(&redirect_uri, &challenge, &state, None)
        .map_err(|error| error.to_string())?;
    println!("{authorize_url}");
    println!("Waiting for callback on {redirect_uri}. Press Ctrl+C to cancel.");
    if listen_host == "0.0.0.0" {
        println!(
            "Listening on 0.0.0.0:{port}; publish this port from Docker so your host browser can reach localhost:{port}."
        );
    }
    std::io::stdout()
        .flush()
        .map_err(|error| error.to_string())?;
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
            let (mut stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
            if let Some(code) = read_callback(&mut stream, &redirect_uri, &state).await? {
                let result = models
                    .exchange_openai_oauth_code(&code, &redirect_uri, &verifier)
                    .await;
                match result {
                    Ok(profile) => {
                        if let Err(error) = models.write_openai_auth_profile(&profile).await {
                            respond(&mut stream, 500, "Codex subscription login failed.").await;
                            return Err(error.to_string());
                        }
                        respond(
                            &mut stream,
                            200,
                            "Codex subscription login complete. You can close this tab.",
                        )
                        .await;
                        let raw = profile.as_json();
                        let label = raw
                            .get("email")
                            .and_then(|value| value.as_str())
                            .or_else(|| raw.get("accountId").and_then(|value| value.as_str()))
                            .unwrap_or("OpenAI account");
                        println!("Codex subscription auth profile saved for {label}.");
                        return Ok(());
                    }
                    Err(error) => {
                        respond(&mut stream, 500, "Codex subscription login failed.").await;
                        return Err(error.to_string());
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

async fn open_browser(url: &str) -> Result<bool, String> {
    let command = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let Ok(mut child) = tokio::process::Command::new(command)
        .arg(url)
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

async fn read_callback(
    stream: &mut TcpStream,
    redirect_uri: &str,
    state: &str,
) -> Result<Option<String>, String> {
    let mut request = vec![0_u8; 8192];
    let mut length = 0;
    loop {
        if length == request.len() {
            respond(stream, 400, "Invalid OAuth callback.").await;
            return Ok(None);
        }
        let count = stream
            .read(&mut request[length..])
            .await
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(None);
        }
        length += count;
        if request[..length]
            .windows(4)
            .any(|bytes| bytes == b"\r\n\r\n")
        {
            break;
        }
    }
    let request = String::from_utf8_lossy(&request[..length]);
    let target = request
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>();
    if target.len() != 3 || target[0] != "GET" {
        respond(stream, 404, "Not found").await;
        return Ok(None);
    }
    if !target[1].starts_with('/') || target[1].starts_with("//") {
        respond(stream, 404, "Not found").await;
        return Ok(None);
    }
    let Ok(current) = url::Url::parse(redirect_uri).and_then(|base| base.join(target[1])) else {
        respond(stream, 404, "Not found").await;
        return Ok(None);
    };
    if current.path() != "/auth/callback" {
        respond(stream, 404, "Not found").await;
        return Ok(None);
    }
    let params: std::collections::HashMap<_, _> = current.query_pairs().into_owned().collect();
    let failure = params
        .get("error")
        .map(|_| "OAuth authorization denied".to_owned())
        .or_else(|| {
            (params.get("state").map(String::as_str) != Some(state))
                .then(|| "OAuth state mismatch".into())
        })
        .or_else(|| {
            (params.get("code").is_none_or(String::is_empty))
                .then(|| "OAuth callback did not include a code".into())
        });
    if let Some(error) = failure {
        respond(stream, 500, "Codex subscription login failed.").await;
        return Err(error);
    }
    Ok(params.get("code").cloned())
}

async fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let status_text = if status == 200 {
        "OK"
    } else if status == 404 {
        "Not Found"
    } else {
        "Internal Server Error"
    };
    let response = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

fn first_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
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
    !cfg!(target_os = "linux")
        || first_env(&["DISPLAY", "WAYLAND_DISPLAY", "WSL_DISTRO_NAME"]).is_some()
}

async fn cancellation() {
    use tokio::signal::unix::{SignalKind, signal};
    // A signal whose listener cannot be installed simply never cancels.
    let term = signal(SignalKind::terminate()).ok();
    let interrupt = signal(SignalKind::interrupt()).ok();
    tokio::select! { () = received(term) => {}, () = received(interrupt) => {} }
}

async fn received(listener: Option<tokio::signal::unix::Signal>) {
    match listener {
        Some(mut listener) => {
            listener.recv().await;
        }
        None => std::future::pending().await,
    }
}
