//! Lexical protected-path screening, shared by direct and approved commands.
//! This guard is not an OS sandbox and cannot interpret arbitrary programs.
use super::{CommandScope, GuidedCommand, active_root, error, ledger_guard};
use butler_core::json::JsonDocument;
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
        let rejected = self.jobs.run(move || {
            let cwd = Commands::guarded_directory(&root, requested.as_deref())?;
            let denied = sensitive(&command)
                .or_else(|| ledger_guard::guard(&command, &cwd, &root, &data, installation.as_deref(), home.as_deref()));
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

fn sensitive(command: &str) -> Option<Value> {
    let denied = |target: &str| {
        json!({"error":"protected_path", "message":"Credential paths are protected.",
        "protected_path":target,
        "next":[{"action":"Use credential tools for credentials; inspect ordinary files with normal approval."}]})
    };
    for raw in butler_platform::command_sandbox::path_tokens(command) {
        let token = butler_platform::command_sandbox::normalize_path_token(raw);
        if looks_sensitive(&token) {
            return Some(denied(raw));
        }
    }
    None
}
