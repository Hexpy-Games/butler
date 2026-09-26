//! Source run_command artifact projection for the registered full-access route.

mod git;
mod scan;
mod verify;

use std::path::Path;

use serde_json::{Map, Value};

use super::artifacts::Artifact;

pub(super) use git::{GitSnapshot, snapshot};

pub(super) struct RegisteredArtifacts {
    pub requested: usize,
    pub declared: usize,
    pub artifacts: Vec<Artifact>,
    pub git_eligible: bool,
}

pub(super) fn publish(
    args: &Map<String, Value>,
    stdout_paths: &[String],
    cwd: &Path,
    workspace: &Path,
    data: &Path,
    started: std::time::SystemTime,
    success: bool,
) -> RegisteredArtifacts {
    let paths = string_array(args.get("output_paths"));
    let requested = paths.len();
    let declared = verify::from_paths(&paths, cwd, workspace, data, true);
    let declared_count = declared.len();
    if declared_count > 0 {
        return RegisteredArtifacts {
            requested,
            declared: declared_count,
            artifacts: declared,
            git_eligible: false,
        };
    }
    let stdout = verify::from_paths(stdout_paths, cwd, workspace, data, false);
    if !stdout.is_empty() {
        return RegisteredArtifacts {
            requested,
            declared: 0,
            artifacts: stdout,
            git_eligible: false,
        };
    }
    RegisteredArtifacts {
        requested,
        declared: 0,
        artifacts: scan::recent_generated(data, cwd, workspace, started),
        git_eligible: success,
    }
}

pub(super) fn append_git_delta(
    publication: &mut RegisteredArtifacts,
    before: &GitSnapshot,
    after: &GitSnapshot,
    workspace: &Path,
    data: &Path,
) {
    if !publication.git_eligible {
        return;
    }
    let changed = git::changed_paths(before, after);
    publication.artifacts.extend(verify::from_paths(
        &changed, workspace, workspace, data, true,
    ));
    verify::unique(&mut publication.artifacts);
}

pub(super) fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .collect()
}
