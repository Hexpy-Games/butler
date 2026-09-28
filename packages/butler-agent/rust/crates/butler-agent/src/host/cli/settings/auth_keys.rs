//! `butler auth keys`: saved provider API keys (#217).
//!
//! - `butler auth keys [list]`: the keys, masked, with their store and the
//!   models that use them.
//! - `butler auth keys replace <name> [--verify]`: replaces a key. The new
//!   key is typed at the terminal without echo, or read as one line from
//!   piped standard input; never from the command line (where other
//!   processes could see it).
//! - `butler auth keys delete <name> --yes [--force]`: deletes a key. A key
//!   the default model uses is refused; `--force` also unregisters other
//!   models that use it.
//!
//! `<name>` is the key's id, or its label when exactly one key has it.

use std::{path::Path, process::ExitCode};

use serde_json::json;

use super::{CliError, Command, Options, ResolvedInstallation, path, report_error, report_success};
use butler_models::models::{self, CredentialError, CredentialList, ModelConfiguration};

/// The files a key change reads or writes, relative to DATA.
const KEY_FILES: [&str; 3] = [
    "butler.config.json",
    "auth/model-provider-credentials.json",
    "auth/credential-store.json",
];

pub(super) async fn run(
    options: &Options,
    command: Command,
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> ExitCode {
    match execute(options, data_root, installation).await {
        Ok((data, human)) => report_success(options, command.name(), &data, &human),
        Err(error) => report_error(command.name(), options.json, &error),
    }
}

async fn execute(
    options: &Options,
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<(serde_json::Value, String), CliError> {
    let (words, flags): (Vec<&str>, Vec<&str>) = options
        .positionals
        .iter()
        .skip(2)
        .map(String::as_str)
        .partition(|value| !value.starts_with("--"));
    let action = words.first().copied().unwrap_or("list");
    let allowed: &[&str] = match action {
        "replace" => &["--verify"],
        "delete" => &["--force"],
        _ => &[],
    };
    if let Some(flag) = flags.iter().find(|flag| !allowed.contains(flag)) {
        return Err(CliError::invalid(format!(
            "unknown auth keys option {flag}"
        )));
    }
    for relative in KEY_FILES {
        path::safe_data_file(installation, data_root, &data_root.join(relative))?;
    }
    let owner = models::open_status_models(data_root.to_path_buf())
        .await
        .map_err(|error| CliError::failed("auth_keys_failed", error.to_string()))?;
    let configuration = &owner.configuration;
    match (action, words.get(1)) {
        ("list", None) => list(configuration, data_root).await,
        ("replace", Some(name)) => {
            let verify = flags.contains(&"--verify");
            replace(configuration, name, verify, data_root).await
        }
        ("delete", Some(name)) if options.yes || options.non_interactive => {
            delete(configuration, name, flags.contains(&"--force"), data_root).await
        }
        ("delete", Some(_)) => Err(CliError::invalid("auth keys delete requires --yes")),
        _ => Err(CliError::invalid(
            "usage: auth keys [list] | replace <name> [--verify] | delete <name> --yes [--force]",
        )),
    }
}

async fn list(
    configuration: &ModelConfiguration,
    data_root: &Path,
) -> Result<(serde_json::Value, String), CliError> {
    let list = configuration
        .list_provider_credentials(data_root)
        .await
        .map_err(key_error)?;
    let human = human_list(&list);
    let data = serde_json::to_value(&list).map_err(|error| {
        CliError::failed("auth_keys_failed", "the key list could not be encoded").with_source(error)
    })?;
    Ok((data, human))
}

fn human_list(list: &CredentialList) -> String {
    let store = serde_json::to_value(list.store.backend).unwrap_or_default();
    let mut lines = vec![format!(
        "New keys are kept in: {}",
        store.as_str().unwrap_or("unknown")
    )];
    if list.credentials.is_empty() {
        lines.push("No API keys are saved.".to_owned());
    }
    for item in &list.credentials {
        let credential = &item.credential;
        let storage = serde_json::to_value(credential.storage).unwrap_or_default();
        lines.push(format!(
            "{}  {}  {}  {}  models={}  id={}",
            credential.label,
            credential.provider_id,
            credential.masked_value,
            storage.as_str().unwrap_or("unknown"),
            item.model_refs.len(),
            credential.id,
        ));
    }
    lines.join("\n")
}

async fn replace(
    configuration: &ModelConfiguration,
    name: &str,
    verify: bool,
    data_root: &Path,
) -> Result<(serde_json::Value, String), CliError> {
    // From a terminal the key is typed without echo; piped, it is one line.
    let key = tokio::task::spawn_blocking(|| models::read_secret_input("New API key: "))
        .await
        .map_err(|error| {
            CliError::failed("auth_keys_failed", "the key was not read").with_source(error)
        })?
        .map_err(|error| {
            CliError::failed("auth_keys_failed", "the key was not read").with_source(error)
        })?;
    let credential = configuration
        .replace_provider_credential(name, key.expose(), verify, data_root)
        .await
        .map_err(key_error)?;
    let human = format!(
        "API key {} replaced ({}).",
        credential.label, credential.masked_value
    );
    Ok((json!({ "credential": credential }), human))
}

async fn delete(
    configuration: &ModelConfiguration,
    name: &str,
    force: bool,
    data_root: &Path,
) -> Result<(serde_json::Value, String), CliError> {
    let deleted = configuration
        .delete_provider_credential(name, force, data_root)
        .await
        .map_err(key_error)?;
    let human = format!("API key {} deleted.", deleted.credential.label);
    let data = serde_json::to_value(&deleted).map_err(|error| {
        CliError::failed("auth_keys_failed", "the result could not be encoded").with_source(error)
    })?;
    Ok((data, human))
}

/// The CLI error of a key operation: its stable code and message (never the
/// key). Usage conflicts exit 1 like other refused changes.
fn key_error(error: CredentialError) -> CliError {
    CliError::failed(error.code(), error.to_string()).with_source(error)
}
