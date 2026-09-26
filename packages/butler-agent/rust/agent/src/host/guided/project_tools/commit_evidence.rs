//! Source Git commit evidence normalization using the existing tracked command owner.

use crate::workspace::CommandError;
use std::{collections::HashMap, path::Path};

use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    public_text::trim_js_whitespace,
    workspace::{CommandStep, NativeCommands, StructuredCommandInput},
};

const INSTALL_URL: &str = "https://git-scm.com/downloads";

pub(super) async fn normalize(
    name: &str,
    args: &Map<String, Value>,
    workspace: Option<&Path>,
    commands: &NativeCommands,
    host_environment: &HashMap<String, String>,
    cancel: CancellationToken,
) -> Result<Map<String, Value>, Value> {
    if name != "project_ledger_work_complete" {
        return Ok(args.clone());
    }
    let code_commit = text(args.get("code_commit"));
    let code_commits = text(args.get("code_commits"));
    if code_commit.is_empty() && code_commits.is_empty() {
        return Ok(args.clone());
    }
    let collect = code_commit == "auto" || !canonical_commits(code_commits);
    let evidence = if collect {
        let workspace = workspace
            .filter(|path| {
                path.to_str()
                    .is_some_and(|text| !trim_js_whitespace(text).is_empty())
            })
            .ok_or_else(|| {
                failure(
                    "git_evidence_failed",
                    "The active project workspace is required to collect Git commit evidence.",
                )
            })?;
        let evidence = collect_evidence(commands, host_environment, workspace, cancel).await?;
        serde_json::to_string(&[evidence]).map_err(|_| {
            failure(
                "git_evidence_failed",
                "Unable to encode Git commit evidence from the active workspace.",
            )
        })?
    } else {
        code_commits.to_owned()
    };
    let mut normalized = args.clone();
    normalized.insert("code_commits".into(), evidence.into());
    normalized.remove("code_commit");
    Ok(normalized)
}

#[derive(Serialize)]
struct Evidence {
    repo: String,
    hash: String,
    message: String,
    branch: String,
    #[serde(rename = "committedAt")]
    committed_at: String,
}

async fn collect_evidence(
    commands: &NativeCommands,
    environment: &HashMap<String, String>,
    workspace: &Path,
    cancel: CancellationToken,
) -> Result<Evidence, Value> {
    let top = git_text(
        commands,
        environment,
        workspace,
        &["rev-parse", "--show-toplevel"],
        &cancel,
    )
    .await?;
    let top_path = Path::new(&top);
    let repo = top_path
        .file_name()
        .map(|part| part.to_string_lossy().into_owned())
        .unwrap_or_default();
    let hash = git_text(
        commands,
        environment,
        top_path,
        &["rev-parse", "--short=12", "HEAD"],
        &cancel,
    )
    .await?;
    let message = git_text(
        commands,
        environment,
        top_path,
        &["log", "-1", "--format=%s"],
        &cancel,
    )
    .await?;
    let branch = git_text(
        commands,
        environment,
        top_path,
        &["branch", "--show-current"],
        &cancel,
    )
    .await?;
    let committed_at = git_text(
        commands,
        environment,
        top_path,
        &["log", "-1", "--format=%cI"],
        &cancel,
    )
    .await?;
    Ok(Evidence {
        repo,
        hash,
        message,
        branch: if branch.is_empty() {
            "detached".into()
        } else {
            branch
        },
        committed_at,
    })
}

async fn git_text(
    commands: &NativeCommands,
    environment: &HashMap<String, String>,
    cwd: &Path,
    args: &[&str],
    cancel: &CancellationToken,
) -> Result<String, Value> {
    let executable = environment
        .get("BUTLER_GIT_EXECUTABLE")
        .map(|value| trim_js_whitespace(value))
        .filter(|value| !value.is_empty())
        .unwrap_or("git");
    let receiver = commands
        .submit_structured(StructuredCommandInput {
            steps: vec![CommandStep {
                executable: executable.into(),
                arguments: args.iter().map(|arg| (*arg).into()).collect(),
            }],
            cwd: Some(cwd.to_path_buf()),
            environment: HashMap::new(),
            host_environment: environment.clone(),
            inherit_environment: true,
            stdin: String::new(),
            timeout_ms: Some(5_000.0),
            abort: cancel.clone(),
            legacy: None,
        })
        .map_err(|error| {
            failure(
                "git_evidence_failed",
                &format!("Unable to collect Git commit evidence: {}", error.message()),
            )
        })?;
    let result = receiver.await.map_err(|_| {
        failure(
            "git_evidence_failed",
            "Unable to collect Git commit evidence: Git result lost",
        )
    })?;
    if result.exit_code != Some(0) {
        let code = if result
            .error
            .as_ref()
            .is_some_and(|error| error.io_kind() == Some(std::io::ErrorKind::NotFound))
        {
            "git_not_installed"
        } else {
            "git_evidence_failed"
        };
        let detail = result.stderr.trim();
        let detail = if detail.is_empty() {
            result
                .error
                .as_ref()
                .map(CommandError::message)
                .unwrap_or_default()
        } else {
            detail.to_owned()
        };
        let detail = if detail.is_empty() {
            args.join(" ")
        } else {
            detail
        };
        return Err(failure(
            code,
            &format!("Unable to collect Git commit evidence: {detail}"),
        ));
    }
    Ok(trim_js_whitespace(&result.stdout).to_owned())
}

fn canonical_commits(source: &str) -> bool {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(source) else {
        return false;
    };
    !items.is_empty()
        && items.iter().all(|item| {
            let Some(item) = item.as_object() else {
                return false;
            };
            ["repo", "hash", "message"]
                .iter()
                .all(|field| !text(item.get(*field)).is_empty())
        })
}

fn text(value: Option<&Value>) -> &str {
    value
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .unwrap_or("")
}

fn failure(code: &str, message: &str) -> Value {
    let missing = code == "git_not_installed";
    let mut error = json!({"code":code,"message":if missing { "Git is not installed. Butler can continue, but Git commit evidence is unavailable." } else { message }});
    if missing {
        error["install_url"] = INSTALL_URL.into();
    } else {
        error["recovery_guidance"] = "Restore a valid Git workspace, then retry the original completion call with its required evidence fields.".into();
    }
    json!({"ok":false,"recoverable":true,"butler_operational":true,"git_features_available":false,"error":error})
}
