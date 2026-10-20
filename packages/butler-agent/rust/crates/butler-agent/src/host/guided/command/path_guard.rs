//! Lexical protected-path screening, shared by direct and approved commands.
//! This guard is not an OS sandbox and cannot interpret arbitrary programs.
use super::{CommandScope, GuidedCommand, active_root, error, ledger_guard};
use butler_core::json::JsonDocument;
use butler_platform::command_sandbox::{PathCandidate, PathScreen, screen_paths};
use butler_platform::secure_fs::Canonical as _;
use butler_turn::btcc::BtccError;
use butler_turn::workspace::{Commands, looks_sensitive};
use serde_json::{Map, Value, json};
use std::path::Path;

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
        let host = self.host_environment.clone();
        let path_form = super::directory_path_form(scope.contained_reads);
        let registered = scope.execution == super::CommandExecution::Registered;
        let strict = registered
            && !scope.full_access
            && !butler_platform::command_sandbox::approval_free_reads();
        // Full Access deliberately keeps best-effort lexical screening: the
        // owner granted unrestricted execution, including incomplete syntax.
        timing.mark("before_job");
        let rejected = self.jobs.run(move || {
            let timing = super::timing::CommandTiming::new("guard_work");
            let cwd = Commands::guarded_directory_in_scope(&root, requested.as_deref(), path_form)?;
            timing.mark("cwd_done");
            let environment = Commands::tool_environment(&host, &data)?;
            let home = butler_platform::command_sandbox::resolve_path_token("~", &cwd, &environment);
            let paths = screen_paths(&command, &cwd, &environment);
            // No match means no lexical rejection, never proof that a program is safe.
            let denied = if strict && !paths.complete {
                Some(json!({"error":"command_path_unknown",
                    "message":"Cannot resolve command paths. Use a simpler path.",
                    "next":[{"action":"Use a simpler command with explicit paths."}]}))
            } else {
                registered.then(|| sensitive(&paths, &cwd, &data, &host, strict)).flatten()
            }
                .or_else(|| registered.then(|| ledger_guard::guard((&command, &paths), &cwd, &root, &data, installation.as_deref(), home.as_deref())).flatten());
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
    paths: &PathScreen,
    cwd: &Path,
    data: &Path,
    environment: &std::collections::HashMap<String, String>,
    ancestors: bool,
) -> Option<Value> {
    let denied = |target: &str| {
        json!({"error":"protected_path", "message":"Credential paths are protected.",
        "protected_path":target,
        "next":[{"action":"Use credential tools for credentials; inspect ordinary files with normal approval."}]})
    };
    let inventory = butler_platform::secure_fs::SecretInventory::for_environment(data, environment);
    let mut credentials = inventory.resolved_paths();
    credentials.extend(inventory.paths().iter().cloned());
    for directory in [
        cwd.to_path_buf(),
        cwd.canonical().unwrap_or_else(|_| cwd.to_path_buf()),
    ] {
        if looks_sensitive(&directory.to_string_lossy()) || inventory.protects_path(&directory) {
            return Some(denied(&directory.to_string_lossy()));
        }
    }
    for candidate in &paths.candidates {
        let resolved = PathCandidate {
            text: candidate.text.clone(),
            glob: candidate.glob,
            path: candidate.path.as_deref().map(ledger_guard::real_or_nearest),
        };
        if looks_sensitive(&candidate.text)
            || resolved
                .path
                .as_ref()
                .is_some_and(|path| looks_sensitive(&path.to_string_lossy()))
            || credentials.iter().any(|root| {
                resolved.could_access(root)
                    || candidate.could_access(root)
                    || ancestors && (resolved.could_reach(root) || candidate.could_reach(root))
            })
        {
            return Some(denied(&candidate.text));
        }
    }
    None
}
