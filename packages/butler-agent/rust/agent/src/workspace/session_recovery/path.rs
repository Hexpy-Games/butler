use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub(in crate::workspace) struct WorktreeEntry {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
}

pub(super) fn precheck_linked_worktree(path: &str) -> bool {
    let path = Path::new(path);
    if !path.exists() {
        return false;
    }
    let Ok(link) = path.symlink_metadata() else {
        return false;
    };
    if link.file_type().is_symlink() {
        return false;
    }
    path.metadata().is_ok_and(|metadata| metadata.is_dir())
}

pub(in crate::workspace) fn parse_worktrees(stdout: &str) -> std::io::Result<Vec<WorktreeEntry>> {
    let mut entries = Vec::new();
    let mut fields = Vec::new();
    for field in stdout.split('\0') {
        if field.is_empty() {
            if !fields.is_empty() {
                if let Some(entry) = parse_record(&fields)? {
                    entries.push(entry);
                }
                fields.clear();
            }
        } else {
            fields.push(field);
        }
    }
    if !fields.is_empty()
        && let Some(entry) = parse_record(&fields)?
    {
        entries.push(entry);
    }
    Ok(entries)
}

fn parse_record(fields: &[&str]) -> std::io::Result<Option<WorktreeEntry>> {
    let mut path = None;
    let mut head = None;
    let mut branch = None;
    for field in fields {
        for line in field.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if path.is_none() {
                path = line.strip_prefix("worktree ");
            }
            if head.is_none() {
                head = line.strip_prefix("HEAD ");
            }
            if branch.is_none() {
                branch = line.strip_prefix("branch ");
            }
        }
    }
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    Ok(Some(WorktreeEntry {
        path: canonical_path(path)?,
        head: head.filter(|head| !head.is_empty()).map(str::to_owned),
        branch: branch
            .and_then(|branch| branch.strip_prefix("refs/heads/"))
            .map(str::to_owned),
    }))
}

pub(super) fn listed_worktree_matches(
    stdout: String,
    target: String,
    branch: String,
) -> std::io::Result<bool> {
    let entries = parse_worktrees(&stdout)?;
    for entry in entries {
        let listed = canonical_path(&entry.path.to_string_lossy())?;
        let requested = canonical_path(&target)?;
        if listed == requested && entry.branch.as_deref() == Some(&branch) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(in crate::workspace) fn canonical_path(path: &str) -> std::io::Result<PathBuf> {
    Path::new(path)
        .canonicalize()
        .or_else(|_| lexical_resolve(Path::new(path)))
}

fn lexical_resolve(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut result = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    Ok(result)
}
