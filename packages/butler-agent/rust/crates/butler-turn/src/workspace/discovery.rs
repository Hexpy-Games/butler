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

pub struct WorkspaceListInput {
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
pub struct WorkspaceListLimits {
    pub max_results: usize,
    pub max_files: usize,
    pub max_dirs: usize,
    pub max_depth: usize,
    pub elapsed_ms: u64,
}

pub struct WorkspaceListRejection {
    pub reason: &'static str,
    pub safe_path: Option<String>,
    pub guard: Value,
}

pub struct WorkspaceListEntry {
    pub path: String,
    pub bytes: u64,
}

/// Why a listing stopped before walking the whole tree; the strings are
/// reported to the model as `stopped_by`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListStop {
    ElapsedMs,
    MaxDepth,
    MaxDirs,
    MaxFiles,
    MaxResults,
    IoError,
}

impl ListStop {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ElapsedMs => "elapsed_ms",
            Self::MaxDepth => "max_depth",
            Self::MaxDirs => "max_dirs",
            Self::MaxFiles => "max_files",
            Self::MaxResults => "max_results",
            Self::IoError => "io_error",
        }
    }
}

pub struct WorkspaceListResult {
    pub root: String,
    pub files: Vec<WorkspaceListEntry>,
    pub files_considered: usize,
    pub dirs_visited: usize,
    pub io_errors: usize,
    pub elapsed_ms: u64,
    pub stopped_by: Option<ListStop>,
    pub last_file_path: Option<String>,
    pub last_path: Option<String>,
}

pub enum WorkspaceListOutcome {
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
    stopped_by: Option<ListStop>,
    last_file_path: Option<String>,
    last_path: Option<String>,
}

/// Whether the walk goes on to the next directory entry.
enum Next {
    Continue,
    Stop,
}

impl Walk<'_> {
    fn elapsed(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis().min(u128::from(u64::MAX)))
            .unwrap_or(u64::MAX)
    }

    fn stop(&mut self, reason: ListStop) {
        if self.stopped_by.is_none() {
            self.stopped_by = Some(reason);
        }
    }

    fn io_error(&mut self) -> Next {
        self.io_errors += 1;
        self.stop(ListStop::IoError);
        Next::Stop
    }

    /// Walks one directory depth-first in UTF-16 name order until a limit stops it.
    fn visit(&mut self, directory: &Path, depth: usize) -> std::io::Result<()> {
        if self.stopped_by.is_some() {
            return Ok(());
        }
        if self.elapsed() >= self.input.limits.elapsed_ms {
            self.stop(ListStop::ElapsedMs);
            return Ok(());
        }
        if depth > self.input.limits.max_depth {
            self.stop(ListStop::MaxDepth);
            return Ok(());
        }
        match std::fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Ok(()),
            Err(_) => {
                self.io_error();
                return Ok(());
            }
        }
        self.dirs_visited += 1;
        if self.dirs_visited > self.input.limits.max_dirs {
            self.stop(ListStop::MaxDirs);
            return Ok(());
        }
        let Ok(mut children) =
            std::fs::read_dir(directory).and_then(Iterator::collect::<std::io::Result<Vec<_>>>)
        else {
            self.io_error();
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
                self.stop(ListStop::ElapsedMs);
                break;
            }
            if let Next::Stop = self.visit_entry(&child, depth)? {
                break;
            }
        }
        Ok(())
    }

    /// Skips sensitive, protected and excluded entries, descends into
    /// directories and considers regular files.
    fn visit_entry(&mut self, child: &std::fs::DirEntry, depth: usize) -> std::io::Result<Next> {
        let path = child.path();
        let Ok(relative) = path.strip_prefix(self.root) else {
            return Ok(Next::Continue);
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if relative.is_empty()
            || looks_sensitive(&relative)
            || protected_path(self.root, &path, &self.input.protected_roots)
        {
            return Ok(Next::Continue);
        }
        let Ok(file_type) = child.file_type() else {
            return Ok(self.io_error());
        };
        if file_type.is_dir() {
            if EXCLUDED_DIRS.contains(&child.file_name().to_string_lossy().as_ref())
                || self.excluded_directory(&relative)
            {
                return Ok(Next::Continue);
            }
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => return Ok(Next::Continue),
                Err(_) => return Ok(self.io_error()),
            }
            self.last_path = Some(relative);
            self.visit(&path, depth + 1)?;
            return Ok(Next::Continue);
        }
        if !file_type.is_file() {
            return Ok(Next::Continue);
        }
        Ok(self.consider_file(&path, relative))
    }

    /// Counts a file past the resume cursor and lists it when the globs select it.
    fn consider_file(&mut self, path: &Path, relative: String) -> Next {
        if self.input.after_path.as_deref().is_some_and(|after| {
            let order = utf16_cmp(&relative, after);
            order.is_lt() || (order.is_eq() && !self.input.include_after_path)
        }) {
            return Next::Continue;
        }
        self.files_considered += 1;
        if self.files_considered > self.input.limits.max_files {
            self.stop(ListStop::MaxFiles);
            return Next::Stop;
        }
        self.last_file_path = Some(relative.clone());
        self.last_path = Some(relative.clone());
        if self.exclude.iter().any(|glob| glob.matches(&relative))
            || (!self.include.is_empty()
                && !self.include.iter().any(|glob| glob.matches(&relative)))
        {
            return Next::Continue;
        }
        let size = match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() => metadata.len(),
            Ok(_) => return Next::Continue,
            Err(_) => return self.io_error(),
        };
        self.entries.push(WorkspaceListEntry {
            path: relative,
            bytes: size,
        });
        if self.entries.len() >= self.input.limits.max_results {
            self.stop(ListStop::MaxResults);
            return Next::Stop;
        }
        Next::Continue
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
