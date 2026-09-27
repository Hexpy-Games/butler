use serde_json::Value;

use crate::public_text::trim_js_whitespace;
use crate::workspace::StoredSessionBinding;

const MARKER_SCHEMA: &str = "butler.session-workspace-binding.v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionWorkspaceMarker {
    pub repository_anchor_path: String,
    pub branch: String,
    pub bound_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionWorkspaceAuthority {
    Project {
        workspace_path: Option<String>,
    },
    SessionWorktree {
        workspace_path: String,
        branch: String,
        workspace_label: String,
        marker: SessionWorkspaceMarker,
    },
    Unavailable {
        workspace_path: String,
        workspace_label: &'static str,
        error_code: &'static str,
    },
}

enum ParsedMarker {
    Absent,
    Invalid,
    Valid(SessionWorkspaceMarker),
}

pub(super) fn resolve_authority(
    binding: Option<&StoredSessionBinding>,
    project_workspace_path: Option<&str>,
) -> SessionWorkspaceAuthority {
    let marker = parse_marker(
        binding
            .and_then(|binding| binding.metadata.as_ref())
            .and_then(|metadata| metadata.get("sessionWorkspace")),
    );
    match marker {
        ParsedMarker::Invalid => SessionWorkspaceAuthority::Unavailable {
            workspace_path: binding
                .map(|binding| binding.workspace_path.clone())
                .or_else(|| project_workspace_path.map(str::to_owned))
                .unwrap_or_default(),
            workspace_label: "Session worktree",
            error_code: "session_workspace_marker_invalid",
        },
        ParsedMarker::Valid(marker) => SessionWorkspaceAuthority::SessionWorktree {
            workspace_path: binding
                .map(|binding| binding.workspace_path.clone())
                .unwrap_or_default(),
            branch: marker.branch.clone(),
            workspace_label: public_workspace_label(&marker.branch),
            marker,
        },
        ParsedMarker::Absent => SessionWorkspaceAuthority::Project {
            workspace_path: project_workspace_path
                .map(str::to_owned)
                .or_else(|| binding.map(|binding| binding.workspace_path.clone())),
        },
    }
}

fn parse_marker(raw: Option<&Value>) -> ParsedMarker {
    let Some(raw) = raw else {
        return ParsedMarker::Absent;
    };
    let Some(marker) = raw.as_object() else {
        return ParsedMarker::Invalid;
    };
    let Some(anchor) = marker.get("repositoryAnchorPath").and_then(Value::as_str) else {
        return ParsedMarker::Invalid;
    };
    let Some(branch) = marker.get("branch").and_then(Value::as_str) else {
        return ParsedMarker::Invalid;
    };
    let Some(bound_at) = marker.get("boundAt").and_then(Value::as_str) else {
        return ParsedMarker::Invalid;
    };
    if marker.get("schema").and_then(Value::as_str) != Some(MARKER_SCHEMA)
        || marker.get("ownership").and_then(Value::as_str) != Some("session")
        || !std::path::Path::new(anchor).is_absolute()
        || trim_js_whitespace(branch).is_empty()
        || !safe_ref_input(trim_js_whitespace(branch))
        || trim_js_whitespace(bound_at).is_empty()
    {
        return ParsedMarker::Invalid;
    }
    ParsedMarker::Valid(SessionWorkspaceMarker {
        repository_anchor_path: anchor.to_owned(),
        branch: branch.to_owned(),
        bound_at: bound_at.to_owned(),
    })
}

fn safe_ref_input(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.starts_with("refs/")
        && !value.contains(['\0', '\r', '\n'])
        && value != "HEAD"
        && !["..", "@{", "~", "^"]
            .into_iter()
            .any(|part| value.contains(part))
}

pub(super) fn public_workspace_label(branch: &str) -> String {
    format!("session-worktree/{branch}")
        .chars()
        .take(80)
        .collect()
}

#[cfg(test)]
pub(super) fn safe_workspace_basename(path: Option<&str>) -> String {
    let basename = path
        .filter(|path| !path.is_empty())
        .map(|path| {
            let separator = |character| character == '/' || (cfg!(windows) && character == '\\');
            path.trim_end_matches(separator)
                .rsplit(separator)
                .next()
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let safe: String = basename
        .chars()
        .filter(|character| (*character as u32) > 31 && (*character as u32) != 127)
        .collect();
    let safe = trim_js_whitespace(&safe);
    let units: Vec<u16> = safe.encode_utf16().take(80).collect();
    let sliced = String::from_utf16_lossy(&units);
    if sliced.is_empty() {
        "Project".into()
    } else {
        sliced
    }
}
