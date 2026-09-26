//! Guarded, bounded discovery of regular workspace files.

mod glob;

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::Value;

use self::glob::{WorkspaceGlob, prune_prefix};
use super::path_guard::{
    GuardInput, looks_sensitive, protected_path, resolve_workspace_path_guard,
};

const EXCLUDED_DIRS: &[&str] = &[
    ".cache",
    ".git",
    ".next",
    ".project-ledger",
    ".tmp",
    ".turbo",
    "build",
    "coverage",
    "dist",
    ".generated",
    "generated",
    "node_modules",
    "project-ledger",
    "vendor",
];

pub(crate) struct WorkspaceListInput {
    pub root: PathBuf,
    pub requested_root: String,
    pub relative_only: bool,
    pub protected_roots: Vec<PathBuf>,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub after_path: Option<String>,
    pub include_after_path: bool,
    pub limits: WorkspaceListLimits,
}

#[derive(Clone, Copy)]
pub(crate) struct WorkspaceListLimits {
    pub max_results: usize,
    pub max_files: usize,
    pub max_dirs: usize,
    pub max_depth: usize,
    pub elapsed_ms: u64,
}

pub(crate) struct WorkspaceListRejection {
    pub reason: &'static str,
    pub safe_path: Option<String>,
    pub guard: Value,
}

pub(crate) struct WorkspaceListEntry {
    pub path: String,
    pub bytes: u64,
}

pub(crate) struct WorkspaceListResult {
    pub root: String,
    pub files: Vec<WorkspaceListEntry>,
    pub files_considered: usize,
    pub dirs_visited: usize,
    pub io_errors: usize,
    pub elapsed_ms: u64,
    pub stopped_by: Option<&'static str>,
    pub last_file_path: Option<String>,
    pub last_path: Option<String>,
}

pub(crate) enum WorkspaceListOutcome {
    Rejected(WorkspaceListRejection),
    Listed(WorkspaceListResult),
}

pub(super) fn list_blocking(input: &WorkspaceListInput) -> std::io::Result<WorkspaceListOutcome> {
    let mut guard = resolve_workspace_path_guard(GuardInput {
        root: &input.root,
        requested: &input.requested_root,
        relative_only: input.relative_only,
        allow_directories: true,
        protected_roots: &input.protected_roots,
    })?;
    let not_directory = match guard.accepted() {
        Some((absolute, selected)) => {
            !std::fs::symlink_metadata(absolute)?.is_dir()
                || !std::fs::symlink_metadata(selected)?.is_dir()
        }
        None => false,
    };
    if not_directory {
        guard.reason = Some("not_a_directory");
    }
    let Some((_, root_path)) = guard.accepted() else {
        return Ok(WorkspaceListOutcome::Rejected(WorkspaceListRejection {
            reason: guard.reason.unwrap_or("path_rejected"),
            safe_path: guard.safe_path(),
            guard: guard.public_rejection(),
        }));
    };
    let displayed_root = root_path
        .strip_prefix(&guard.root)
        .unwrap_or(Path::new(""))
        .to_string_lossy()
        .replace('\\', "/");
    let started = Instant::now();
    let include = input
        .include_globs
        .iter()
        .map(|pattern| WorkspaceGlob::new(pattern))
        .collect();
    let exclude = input
        .exclude_globs
        .iter()
        .map(|pattern| WorkspaceGlob::new(pattern))
        .collect();
    let mut walk = Walk {
        input,
        root: &guard.root,
        include,
        exclude,
        started,
        entries: Vec::new(),
        files_considered: 0,
        dirs_visited: 0,
        io_errors: 0,
        stopped_by: None,
        last_file_path: None,
        last_path: None,
    };
    walk.visit(root_path, 0)?;
    walk.entries
        .sort_by(|left, right| utf16_cmp(&left.path, &right.path));
    let elapsed_ms = walk.elapsed();
    Ok(WorkspaceListOutcome::Listed(WorkspaceListResult {
        root: if displayed_root.is_empty() {
            ".".into()
        } else {
            displayed_root
        },
        files: walk.entries,
        files_considered: walk.files_considered,
        dirs_visited: walk.dirs_visited,
        io_errors: walk.io_errors,
        elapsed_ms,
        stopped_by: walk.stopped_by,
        last_file_path: walk.last_file_path,
        last_path: walk.last_path,
    }))
}

struct Walk<'a> {
    input: &'a WorkspaceListInput,
    root: &'a Path,
    include: Vec<WorkspaceGlob>,
    exclude: Vec<WorkspaceGlob>,
    started: Instant,
    entries: Vec<WorkspaceListEntry>,
    files_considered: usize,
    dirs_visited: usize,
    io_errors: usize,
    stopped_by: Option<&'static str>,
    last_file_path: Option<String>,
    last_path: Option<String>,
}

impl Walk<'_> {
    fn elapsed(&self) -> u64 {
        self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }

    fn stop(&mut self, reason: &'static str) {
        if self.stopped_by.is_none() {
            self.stopped_by = Some(reason);
        }
    }

    fn visit(&mut self, directory: &Path, depth: usize) -> std::io::Result<()> {
        if self.stopped_by.is_some() {
            return Ok(());
        }
        if self.elapsed() >= self.input.limits.elapsed_ms {
            self.stop("elapsed_ms");
            return Ok(());
        }
        if depth > self.input.limits.max_depth {
            self.stop("max_depth");
            return Ok(());
        }
        match std::fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Ok(()),
            Err(_) => {
                self.io_errors += 1;
                self.stop("io_error");
                return Ok(());
            }
        }
        self.dirs_visited += 1;
        if self.dirs_visited > self.input.limits.max_dirs {
            self.stop("max_dirs");
            return Ok(());
        }
        let mut children = match std::fs::read_dir(directory) {
            Ok(children) => children.collect::<std::io::Result<Vec<_>>>(),
            Err(error) => Err(error),
        };
        let Ok(children) = &mut children else {
            self.io_errors += 1;
            self.stop("io_error");
            return Ok(());
        };
        children.sort_by(|left, right| {
            utf16_cmp(
                &left.file_name().to_string_lossy(),
                &right.file_name().to_string_lossy(),
            )
        });
        for child in children {
            if self.stopped_by.is_some() {
                break;
            }
            if self.elapsed() >= self.input.limits.elapsed_ms {
                self.stop("elapsed_ms");
                break;
            }
            let path = child.path();
            let Ok(relative) = path.strip_prefix(self.root) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative.is_empty()
                || looks_sensitive(&relative)
                || protected_path(self.root, &path, &self.input.protected_roots)
            {
                continue;
            }
            let metadata = match child.file_type() {
                Ok(metadata) => metadata,
                Err(_) => {
                    self.io_errors += 1;
                    self.stop("io_error");
                    break;
                }
            };
            if metadata.is_dir() {
                if EXCLUDED_DIRS.contains(&child.file_name().to_string_lossy().as_ref())
                    || self.excluded_directory(&relative)
                {
                    continue;
                }
                match std::fs::symlink_metadata(&path) {
                    Ok(metadata) if metadata.is_dir() => {}
                    Ok(_) => continue,
                    Err(_) => {
                        self.io_errors += 1;
                        self.stop("io_error");
                        break;
                    }
                }
                self.last_path = Some(relative);
                self.visit(&path, depth + 1)?;
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            if self.input.after_path.as_deref().is_some_and(|after| {
                let order = utf16_cmp(&relative, after);
                order.is_lt() || (order.is_eq() && !self.input.include_after_path)
            }) {
                continue;
            }
            self.files_considered += 1;
            if self.files_considered > self.input.limits.max_files {
                self.stop("max_files");
                break;
            }
            self.last_file_path = Some(relative.clone());
            self.last_path = Some(relative.clone());
            if self.exclude.iter().any(|glob| glob.matches(&relative))
                || (!self.include.is_empty()
                    && !self.include.iter().any(|glob| glob.matches(&relative)))
            {
                continue;
            }
            let size = match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() => metadata.len(),
                Ok(_) => continue,
                Err(_) => {
                    self.io_errors += 1;
                    self.stop("io_error");
                    break;
                }
            };
            self.entries.push(WorkspaceListEntry {
                path: relative,
                bytes: size,
            });
            if self.entries.len() >= self.input.limits.max_results {
                self.stop("max_results");
                break;
            }
        }
        Ok(())
    }

    fn excluded_directory(&self, path: &str) -> bool {
        self.exclude.iter().any(|glob| glob.matches(path))
            || self.input.exclude_globs.iter().any(|pattern| {
                prune_prefix(pattern).is_some_and(|prefix| {
                    !prefix.is_empty()
                        && (path == prefix
                            || path
                                .strip_prefix(prefix)
                                .is_some_and(|rest| rest.starts_with('/')))
                })
            })
    }
}

fn utf16_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}
