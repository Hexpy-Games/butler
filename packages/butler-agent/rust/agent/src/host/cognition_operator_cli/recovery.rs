use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use crate::{
    cognition::{
        CognitionPathEnvironment, ContinuityRecoveryAction, ContinuityRecoveryManifestView,
        ContinuityRecoveryService, ensure_data_authority,
    },
    coordination::CognitionWriteCoordinator,
};

use super::CliError;

pub(super) fn command_name(prefix: &str, args: &[String]) -> String {
    let subcommand = args.get(3).map(String::as_str).unwrap_or("unknown");
    format!("butler {prefix} memory recovery {subcommand}")
}

pub(super) async fn run(
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    args: &[String],
    yes: bool,
    non_interactive: bool,
    installation_root: &Path,
) -> Result<(Value, String), CliError> {
    let rest = args.get(3..).unwrap_or_default();
    let subcommand = rest.first().map(String::as_str).unwrap_or("unknown");
    let service = ContinuityRecoveryService::new(data_root.clone(), paths, coordinator);
    match subcommand {
        "plan" => {
            let project_id = required(rest.get(1), "memory recovery plan requires <project-id>")?;
            let project_id = project_id.trim();
            let workspace = canonical_project_workspace(&data_root, project_id, installation_root)?;
            let view = service
                .plan(project_id, &workspace)
                .await
                .map_err(service_error)?;
            let data = view_value(&view)?;
            Ok((
                data,
                format!(
                    "manifest={} project={} status={}\ncandidates={} approved={} quarantine={}\nDry-run only. Review candidate previews, then use recovery approve before apply.",
                    view.manifest_id,
                    view.project_id,
                    view.status,
                    view.candidate_count,
                    view.approved_count,
                    view.quarantine_count
                ),
            ))
        }
        "inspect" => {
            let manifest_id = required(
                rest.get(1),
                "memory recovery inspect requires <manifest-id>",
            )?;
            let view = service
                .inspect(manifest_id)
                .await
                .map_err(service_error)?
                .ok_or_else(|| {
                    CliError::failed(
                        "not_found",
                        format!("continuity recovery manifest not found: {manifest_id}"),
                    )
                })?;
            let data = view_value(&view)?;
            let candidates = view
                .candidates
                .iter()
                .map(|candidate| format!("{}: {}", candidate.candidate_id, candidate.preview))
                .collect::<Vec<_>>();
            let mut lines = vec![
                format!(
                    "manifest={} project={} status={}",
                    view.manifest_id, view.project_id, view.status
                ),
                format!(
                    "candidates={} approved={} quarantine={}",
                    view.candidate_count, view.approved_count, view.quarantine_count
                ),
            ];
            lines.extend(candidates);
            Ok((data, lines.join("\n")))
        }
        "approve" => {
            require_yes(yes, non_interactive, "memory recovery approve")?;
            let manifest_id = required(
                rest.get(1),
                "memory recovery approve requires <manifest-id> <candidate-id...|all>",
            )?;
            let requested = rest
                .iter()
                .skip(2)
                .filter(|value| !value.starts_with("--"))
                .cloned()
                .collect::<Vec<_>>();
            if requested.is_empty() {
                return Err(CliError::invalid(
                    "memory recovery approve requires <manifest-id> <candidate-id...|all>",
                ));
            }
            let candidate_ids = if requested.len() == 1 && requested[0] == "all" {
                None
            } else {
                Some(requested)
            };
            let view = service
                .approve(manifest_id, candidate_ids)
                .await
                .map_err(service_error)?;
            Ok((
                view_value(&view)?,
                format!(
                    "Approved {} candidate(s) in {}.",
                    view.approved_count, view.manifest_id
                ),
            ))
        }
        "apply" | "rollback" => {
            let action_name = format!("memory recovery {subcommand}");
            require_yes(yes, non_interactive, &action_name)?;
            let manifest_id = required(
                rest.get(1),
                if subcommand == "apply" {
                    "memory recovery apply requires <manifest-id>"
                } else {
                    "memory recovery rollback requires <manifest-id>"
                },
            )?;
            let manifest_view = service
                .inspect(manifest_id)
                .await
                .map_err(service_error)?
                .ok_or_else(|| {
                    CliError::failed(
                        "not_found",
                        format!("continuity recovery manifest not found: {manifest_id}"),
                    )
                })?;
            let workspace = canonical_project_workspace(
                &data_root,
                &manifest_view.project_id,
                installation_root,
            )?;
            let action = if subcommand == "apply" {
                service.apply(manifest_id, &workspace).await
            } else {
                service.rollback(manifest_id, &workspace).await
            }
            .map_err(service_error)?;
            action_value(action, subcommand)
        }
        _ => Err(CliError::failed(
            "unknown_command",
            format!("unknown memory recovery command: {subcommand}"),
        )),
    }
}

fn canonical_project_workspace(
    data_root: &Path,
    project_id: &str,
    installation_root: &Path,
) -> Result<PathBuf, CliError> {
    let workspace = registered_workspace(data_root, project_id)?.ok_or_else(|| {
        CliError::failed(
            "continuity_project_workspace_unresolved",
            "continuity_project_workspace_unresolved",
        )
    })?;
    if !workspace.is_absolute() {
        return Err(CliError::failed(
            "continuity_project_workspace_unresolved",
            "continuity_project_workspace_unresolved",
        ));
    }
    let workspace = fs::canonicalize(&workspace).map_err(|_| {
        CliError::failed(
            "continuity_project_workspace_unresolved",
            "continuity_project_workspace_unresolved",
        )
    })?;
    if !workspace.is_dir() {
        return Err(CliError::failed(
            "continuity_project_workspace_unresolved",
            "continuity_project_workspace_unresolved",
        ));
    }
    let cache = workspace.join(".butler/hot-cache.md");
    let install = fs::canonicalize(installation_root).map_err(|_| {
        CliError::failed(
            "installation_root_unavailable",
            "installation_root_unavailable",
        )
    })?;
    if cache.starts_with(&install) {
        return Err(CliError::failed(
            "continuity_recovery_installation_blocked",
            "project hot-cache recovery may not mutate the native installation",
        ));
    }
    if let Ok(parent) = fs::canonicalize(workspace.join(".butler"))
        && (!parent.starts_with(&workspace) || parent.starts_with(&install))
    {
        return Err(CliError::failed(
            "continuity_recovery_project_binding_changed",
            "project hot-cache path is outside its canonical workspace",
        ));
    }
    Ok(workspace)
}

fn registered_workspace(data_root: &Path, project_id: &str) -> Result<Option<PathBuf>, CliError> {
    let app_db = data_root.join("app-server/butler-client.sqlite");
    ensure_data_authority(data_root, &[&app_db]).map_err(service_error)?;
    if app_db.exists()
        && let Ok(database) = Connection::open_with_flags(&app_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
    {
        let registered = database
            .query_row(
                "SELECT workspace_path FROM projects WHERE id=?1 AND archived=0 LIMIT 1",
                [project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute());
        if registered.is_some() {
            return Ok(registered);
        }
    }

    let config = data_root.join("butler.config.json");
    ensure_data_authority(data_root, &[&config]).map_err(service_error)?;
    let Ok(content) = fs::read_to_string(config) else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Ok(None);
    };
    let Some(projects) = value.get("projects") else {
        return Ok(None);
    };
    let entries = match projects {
        Value::Array(values) => values.iter().collect::<Vec<_>>(),
        Value::Object(values) => values.values().collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    Ok(entries
        .into_iter()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(project_id))
        .and_then(|entry| entry.get("path").and_then(Value::as_str))
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute()))
}

fn action_value(
    action: ContinuityRecoveryAction,
    subcommand: &str,
) -> Result<(Value, String), CliError> {
    let data = view_value(&action.manifest)?;
    let mut data = data;
    data["replayed"] = Value::Bool(action.replayed);
    let human = if subcommand == "apply" {
        format!(
            "Applied {} candidate(s); replayed={}.",
            action.manifest.approved_count, action.replayed
        )
    } else {
        format!(
            "Rolled back {}; replayed={}.",
            action.manifest.manifest_id, action.replayed
        )
    };
    Ok((data, human))
}

fn view_value(view: &ContinuityRecoveryManifestView) -> Result<Value, CliError> {
    serde_json::to_value(view).map_err(|_| {
        CliError::failed(
            "invalid_output",
            "Could not serialize continuity recovery manifest",
        )
    })
}

fn required<'a>(value: Option<&'a String>, message: &str) -> Result<&'a str, CliError> {
    value
        .filter(|value| !value.is_empty())
        .map(String::as_str)
        .ok_or_else(|| CliError::invalid(message))
}

fn require_yes(yes: bool, non_interactive: bool, command: &str) -> Result<(), CliError> {
    if yes || non_interactive {
        Ok(())
    } else {
        Err(CliError::invalid(format!("{command} requires --yes")))
    }
}

fn service_error(error: crate::cognition::CognitionError) -> CliError {
    CliError::failed(error.code, error.message)
}
