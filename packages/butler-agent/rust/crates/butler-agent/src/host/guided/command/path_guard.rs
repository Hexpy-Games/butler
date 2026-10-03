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
            let denied = sensitive(&command, &cwd, &data, home.as_deref())
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

fn sensitive(command: &str, cwd: &Path, data: &Path, home: Option<&Path>) -> Option<Value> {
    let denied = || {
        json!({"error":"protected_path", "message":"Butler data and credentials are protected.",
        "next":[{"action":"Use the admitted Butler tools for runtime data; inspect ordinary user files only."}]})
    };
    for raw in command
        .split(|c: char| {
            c.is_whitespace() || ['\"', '\'', ';', '|', '(', ')', ',', '='].contains(&c)
        })
        .filter(|token| !token.is_empty())
    {
        let token = butler_platform::command_sandbox::normalize_path_token(raw);
        let lower = token.to_ascii_lowercase();
        if looks_sensitive(&token) || lower.split('/').any(|p| p == ".butler") {
            return Some(denied());
        }
        let path = if [
            "$butler_data",
            "${butler_data}",
            "$env:butler_data",
            "%butler_data%",
        ]
        .iter()
        .any(|prefix| lower == *prefix || lower.starts_with(&format!("{prefix}/")))
        {
            return Some(denied());
        } else if let Some(home) = home {
            [
                "$home/",
                "${home}/",
                "$env:home/",
                "$env:userprofile/",
                "%userprofile%/",
                "~/",
            ]
            .iter()
            .find_map(|prefix| {
                lower
                    .strip_prefix(prefix)
                    .map(|_| home.join(&token[prefix.len()..]))
            })
            .unwrap_or_else(|| absolute(&token, cwd))
        } else {
            absolute(&token, cwd)
        };
        // Ordinary non-project chats use DATA as their default CWD. A
        // program name or a script variable is not a filesystem target.
        let file_argument = !butler_platform::command_sandbox::is_registry_path(&token)
            && (Path::new(&token).is_absolute()
                || token.contains('/') && !token.contains(':')
                || path.exists());
        if file_argument && within(&path, data) {
            return Some(denied());
        }
    }
    None
}

fn absolute(token: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(token);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

fn within(path: &Path, root: &Path) -> bool {
    // Resolve existing paths, including symlinks and Windows case aliases.
    let path =
        butler_platform::secure_fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let root =
        butler_platform::secure_fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    butler_platform::secure_fs::path_is_within(&path, &root)
}
