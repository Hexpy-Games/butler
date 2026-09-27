use std::path::Path;
use std::time::{Duration, SystemTime};

use super::super::artifacts::Artifact;
use super::verify;

const IGNORED: &[&str] = &[
    ".git",
    ".turbo",
    ".vite",
    "coverage",
    "dist",
    "build",
    "node_modules",
];
const MAX_FILES: usize = 20_000;
const MAX_ARTIFACTS: usize = 24;

struct ScanContext<'a> {
    data: &'a Path,
    cwd: &'a Path,
    workspace: &'a Path,
    started: SystemTime,
}

#[derive(Default)]
struct ScanState {
    scanned: usize,
    artifacts: Vec<Artifact>,
}

pub(super) fn recent_generated(
    data: &Path,
    cwd: &Path,
    workspace: &Path,
    started: SystemTime,
) -> Vec<Artifact> {
    let context = ScanContext {
        data,
        cwd,
        workspace,
        started,
    };
    let mut state = ScanState::default();
    visit(&data.join("artifacts/generated"), 0, &context, &mut state);
    state.artifacts
}

fn visit(directory: &Path, depth: usize, context: &ScanContext<'_>, state: &mut ScanState) {
    if depth > 8 || state.scanned >= MAX_FILES || state.artifacts.len() >= MAX_ARTIFACTS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        if state.scanned >= MAX_FILES || state.artifacts.len() >= MAX_ARTIFACTS {
            return;
        }
        if IGNORED.contains(&entry.file_name().to_string_lossy().as_ref()) {
            continue;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            visit(&path, depth + 1, context, state);
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        state.scanned += 1;
        let Ok(stat) = std::fs::metadata(&path) else {
            continue;
        };
        let Ok(modified) = stat.modified() else {
            continue;
        };
        if modified
            .checked_add(Duration::from_millis(1000))
            .is_some_and(|limit| limit < context.started)
        {
            continue;
        }
        if let Some(artifact) =
            verify::verified(&path, context.cwd, context.workspace, context.data, false)
        {
            state.artifacts.push(artifact);
        }
    }
}
