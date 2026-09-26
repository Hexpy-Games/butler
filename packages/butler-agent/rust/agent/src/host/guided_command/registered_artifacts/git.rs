use indexmap::IndexMap;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::workspace::{CommandStep, NativeCommands, StructuredCommandInput};

pub(in crate::host::guided_command) type GitSnapshot = IndexMap<String, String>;

pub(super) fn parse_git_status(stdout: &str) -> GitSnapshot {
    let mut records = stdout.split('\0').filter(|record| !record.is_empty());
    let mut snapshot = GitSnapshot::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let status = &record[..2];
        let path = &record[3..];
        if path.is_empty() || path.starts_with(".git/") {
            continue;
        }
        snapshot.insert(path.to_owned(), status.to_owned());
        if status.starts_with('R') || status.starts_with('C') {
            records.next();
        }
    }
    snapshot
}

pub(super) fn changed_paths(before: &GitSnapshot, after: &GitSnapshot) -> Vec<String> {
    after
        .iter()
        .filter(|(path, status)| before.get(*path) != Some(status))
        .map(|(path, _)| path.clone())
        .collect()
}

pub(in crate::host::guided_command) async fn snapshot(
    commands: &NativeCommands,
    workspace: &Path,
    host_environment: Arc<HashMap<String, String>>,
    abort: CancellationToken,
) -> Option<GitSnapshot> {
    let result = commands
        .submit_structured(StructuredCommandInput {
            steps: vec![CommandStep {
                executable: "git".into(),
                arguments: vec![
                    "status".into(),
                    "--porcelain=v1".into(),
                    "-z".into(),
                    "--untracked-files=all".into(),
                ],
            }],
            cwd: Some(workspace.to_path_buf()),
            environment: HashMap::new(),
            host_environment: (*host_environment).clone(),
            inherit_environment: true,
            stdin: String::new(),
            timeout_ms: Some(10_000.0),
            abort,
            legacy: None,
            #[cfg(test)]
            test_late_reap: None,
            #[cfg(test)]
            test_pause_before_second_spawn: None,
        })
        .ok()?
        .await
        .ok()?;
    if result.exit_code != Some(0) || result.timed_out || result.cancelled || result.error.is_some()
    {
        return None;
    }
    Some(parse_git_status(&result.stdout))
}
