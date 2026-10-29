//! Lexical protected-path screening, shared by direct and approved commands.
//! This guard is not an OS sandbox and cannot interpret arbitrary programs.
use super::{CommandScope, GuidedCommand, active_root, error, ledger_guard};
use butler_core::json::JsonDocument;
use butler_platform::secure_fs::Canonical as _;
use butler_turn::btcc::BtccError;
use butler_turn::workspace::{Commands, looks_sensitive};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

impl GuidedCommand {
    pub(crate) async fn check_paths(
        &self,
        args: &Map<String, Value>,
        scope: &CommandScope<'_>,
    ) -> Result<Option<JsonDocument>, BtccError> {
        let timing = super::timing::CommandTiming::new("path_guard");
        let root = active_root(scope)?;
        let requested = args.get("cwd").and_then(Value::as_str).map(str::to_owned);
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let data = scope.butler_data.to_path_buf();
        let installation = scope.installation_root.map(Path::to_path_buf);
        let home = self.host_environment.get("HOME").map(PathBuf::from);
        let deny_secret_reads = scope.deny_secret_reads;
        let inventory = scope.read_inventory();
        let environment = self.host_environment.clone();
        let path_form = super::directory_path_form(scope.contained_reads);
        timing.mark("before_job");
        let rejected = self.jobs.run(move || {
            let timing = super::timing::CommandTiming::new("guard_work");
            let cwd = Commands::guarded_directory_in_scope(&root, requested.as_deref(), path_form)?;
            timing.mark("cwd_done");
            let inventory = deny_secret_reads.then(|| inventory.unwrap_or_else(||
                butler_platform::secure_fs::SecretInventory::for_environment(&data, &environment)));
            let denied = sensitive(&command, &cwd, &data, home.as_deref(), inventory.as_deref())
                .or_else(|| ledger_guard::guard(&command, &cwd, &root, &data, installation.as_deref(), home.as_deref()));
            timing.mark("guard_done");
            Ok::<_, butler_turn::workspace::CommandError>(denied.map(|denied| json!({
                "ok":false,"command":command,"cwd":cwd.to_string_lossy(),"exit_code":1,
                "timed_out":false,"stdout":"","stderr":denied["message"],
                "error":denied["error"],"protected_path":denied["protected_path"],"next":denied["next"]
            })))
        }).await?.map_err(BtccError::from)?;
        rejected
            .map(|value| {
                JsonDocument::from_value(&value)
                    .map_err(|source| error("command_result_encoding_failed").with_source(source))
            })
            .transpose()
    }
}

fn sensitive(
    command: &str,
    cwd: &Path,
    data: &Path,
    home: Option<&Path>,
    inventory: Option<&butler_platform::secure_fs::SecretInventory>,
) -> Option<Value> {
    let denied = |target: &str| {
        json!({"error":"protected_path", "message":"Credential paths are protected.",
        "protected_path":target,
        "next":[{"action":"Use credential tools for credentials; inspect ordinary files with normal approval."}]})
    };
    let credentials: Vec<_> = if let Some(inventory) = inventory {
        inventory
            .paths()
            .iter()
            .cloned()
            .chain(inventory.resolved_paths())
            .collect()
    } else {
        butler_platform::data_paths::GATEWAY_CREDENTIAL_DIRS
            .iter()
            .map(|path| ledger_guard::real_or_nearest(&data.join(path)))
            .collect()
    };
    for directory in [
        cwd.to_path_buf(),
        cwd.canonical().unwrap_or_else(|_| cwd.to_path_buf()),
    ] {
        if looks_sensitive(&directory.to_string_lossy())
            || inventory.is_some_and(|inventory| inventory.protects_path(&directory))
        {
            return Some(denied(&directory.to_string_lossy()));
        }
    }
    for raw in butler_platform::command_sandbox::path_tokens(command) {
        let token = butler_platform::command_sandbox::normalize_path_token(raw);
        if looks_sensitive(&token)
            || names_any(&token, cwd, data, home, &credentials, inventory.is_some())
        {
            return Some(denied(raw));
        }
    }
    None
}

/// Whether `token`, resolved like the Ledger guard resolves paths, names one
/// of the credential folders `credentials` (real paths) or a path beneath one.
fn names_any(
    token: &str,
    cwd: &Path,
    data: &Path,
    home: Option<&Path>,
    credentials: &[PathBuf],
    lexical: bool,
) -> bool {
    ledger_guard::resolve(token, cwd, data, home).is_some_and(|path| {
        let real = ledger_guard::real_or_nearest(&path);
        credentials.iter().any(|credential| {
            butler_platform::secure_fs::path_is_within(&real, credential)
                || (lexical && butler_platform::secure_fs::path_is_within(&path, credential))
        })
    })
}
