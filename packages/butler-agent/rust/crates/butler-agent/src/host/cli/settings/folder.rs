//! Project-folder preference through the App API or its stopped-service store.
use super::{CliError, Command, Options, ResolvedInstallation, report_error, report_success};
use crate::host::runtime::storage_bootstrap::{
    is_unsupported_legacy_data, prepare_fresh_btcc_storage,
};
use crate::host::{cli::gateway, service::configuration::AppServiceConfiguration};
use butler_gateway::gateway::project_folder;
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

pub(super) async fn run(
    options: &Options,
    command: Command,
    data: &Path,
    installation: &ResolvedInstallation,
) -> ExitCode {
    let result = execute(options, command, data, installation).await;
    match result {
        Ok(path) => report_success(options, command.name(), &json!({"path":path}), &path),
        Err(error) => report_error(command.name(), options.json, &error),
    }
}

async fn execute(
    options: &Options,
    command: Command,
    data: &Path,
    installation: &ResolvedInstallation,
) -> Result<String, CliError> {
    let selected = match (command, options.positionals.as_slice()) {
        (Command::FolderShow, [_, _]) => None,
        (Command::FolderSet, [_, _, path]) => Some(PathBuf::from(path)),
        _ => return Err(CliError::invalid("folder requires show or set <path>")),
    };
    let endpoint = gateway::running_app_endpoint(data, installation, Duration::from_secs(5))
        .await
        .map_err(|_| unavailable())?;
    if endpoint.is_none() {
        gateway::require_stopped(data, installation).map_err(|_| unavailable())?;
    }
    let data = data.to_path_buf();
    let installation = installation.clone();
    let online = endpoint.is_some();
    let (app, selected) = tokio::task::spawn_blocking(move || {
        let app = AppServiceConfiguration::capture(&data);
        let selected = selected
            .map(|path| project_folder::validate(&path, &data))
            .transpose()
            .map_err(|error| CliError::invalid(error.to_string()))?;
        if !online {
            super::path::safe_data_file(&installation, &data, &app.db_path)?;
            if selected.is_some() && is_unsupported_legacy_data(&data) {
                return Err(CliError::invalid(
                    "Legacy DATA is unsupported. Use a new data folder.",
                ));
            }
            let _admission = if selected.is_some() {
                Some(
                    crate::host::service::instance::AdmissionLock::acquire(&data, &installation)
                        .map_err(|_| unavailable())?,
                )
            } else {
                None
            };
            gateway::require_stopped(&data, &installation).map_err(|_| unavailable())?;
            let _data_lock = if selected.is_some() {
                Some(
                    crate::host::service::instance::lock_stopped_data(&data)
                        .map_err(|_| unavailable())?,
                )
            } else {
                None
            };
            if selected.is_some() && !data.join("agent-runtime/btcc.sqlite").exists() {
                prepare_fresh_btcc_storage(&data, crate::host::build_info::current().version)
                    .map_err(|_| unavailable())?;
            }
            let path = offline(&app.db_path, selected.as_deref())?;
            return Ok((app, path));
        }
        Ok((app, selected))
    })
    .await
    .map_err(|_| unavailable())??;
    let path = if let Some(endpoint) = endpoint {
        online_request(&app, &endpoint, selected.as_deref()).await?
    } else {
        selected.ok_or_else(unavailable)?
    };
    Ok(path.display().to_string())
}

fn offline(db_path: &Path, selected: Option<&Path>) -> Result<Option<PathBuf>, CliError> {
    let result = if let Some(path) = selected {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| unavailable())?;
        }
        let db = butler_platform::sqlite::open(db_path).map_err(|_| unavailable())?;
        project_folder::write(&db, path, &chrono::Utc::now().to_rfc3339())
            .map_err(|_| unavailable())?;
        Some(path.to_path_buf())
    } else {
        let db = if db_path.exists() {
            Some(
                butler_platform::sqlite::open_with_flags(
                    db_path,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )
                .map_err(|_| unavailable())?,
            )
        } else {
            None
        };
        Some(project_folder::read(db.as_deref()).map_err(|_| unavailable())?)
    };
    Ok(result)
}

async fn online_request(
    app: &AppServiceConfiguration,
    endpoint: &str,
    selected: Option<&Path>,
) -> Result<PathBuf, CliError> {
    let token = app
        .gateway_config()
        .local_auth
        .token()
        .ok_or_else(unavailable)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| unavailable())?;
    let mut request = client
        .request(
            if selected.is_some() {
                Method::PATCH
            } else {
                Method::GET
            },
            format!("{}/settings", endpoint.trim_end_matches('/')),
        )
        .bearer_auth(token);
    if let Some(path) = selected {
        let secret = app
            .folder_selection_secret
            .as_deref()
            .ok_or_else(unavailable)?;
        let selection = project_folder::selection_token(path, secret).map_err(|_| unavailable())?;
        request = request.json(&json!({"default_project_folder_selection_token":selection}));
    }
    let response = request.send().await.map_err(|_| unavailable())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|_| unavailable())?;
    if !status.is_success() {
        return Err(CliError::failed(
            "project_folder_rejected",
            body.pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Project folder rejected."),
        ));
    }
    body.pointer("/data/default_project_workspace_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(unavailable)
}

fn unavailable() -> CliError {
    CliError::failed(
        "project_folder_unavailable",
        "Project folder unavailable. Start the App gateway or stop Butler.",
    )
}
