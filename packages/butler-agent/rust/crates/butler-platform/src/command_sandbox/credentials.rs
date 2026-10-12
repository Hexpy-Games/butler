//! Butler credential exclusions shared by kernel policies and lexical guards.
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
};

/// Credential roots relative to the data folder. Ordinary data stays readable.
const DATA_CREDENTIALS: &[&str] = &[
    "auth",
    "token",
    "app/runtime/auth",
    "state/app-gateway/project-folder-token-secret",
];

/// Private-read exclusions for a data folder, including missing credential files.
pub fn data_credential_roots(data: &Path) -> Vec<PathBuf> {
    DATA_CREDENTIALS
        .iter()
        .map(|relative| data.join(relative))
        .collect()
}

/// Lexical credential screening, with shell environment paths and real aliases.
/// This does not interpret arbitrary shell programs or replace kernel isolation.
pub fn command_reads_data_credentials(
    command: &str,
    cwd: &Path,
    data: &Path,
    environment: &HashMap<String, String>,
) -> bool {
    let roots: Vec<_> = data_credential_roots(data)
        .iter()
        .map(|root| real_or_nearest(root))
        .collect();
    // Keep complete quoted paths as well as lexical candidates from scripts.
    // Tokens inside interpreter arguments still need the ordinary screening.
    super::path_tokens(command)
        .into_iter()
        .chain(command.split(['\'', '"']))
        .any(|raw| {
            let Some(path) = command_path(raw, cwd, data, environment) else {
                return false;
            };
            let target = real_or_nearest(&path);
            roots
                .iter()
                .any(|root| crate::secure_fs::path_is_within(&target, root))
        })
}

fn command_path(
    raw: &str,
    cwd: &Path,
    data: &Path,
    environment: &HashMap<String, String>,
) -> Option<PathBuf> {
    let token = super::normalize_path_token(raw);
    let token = token.trim_matches(['\'', '"', '`']);
    let expanded = if let Some(tail) = token.strip_prefix("~/") {
        Path::new(environment.get("HOME")?).join(tail)
    } else if token.starts_with('$') || token.starts_with('%') {
        let (name, tail) = variable(token)?;
        let value = if name.eq_ignore_ascii_case("BUTLER_DATA") {
            data.to_path_buf()
        } else {
            PathBuf::from(
                environment
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case(name))?
                    .1,
            )
        };
        value.join(tail.trim_start_matches('/'))
    } else {
        PathBuf::from(token)
    };
    Some(if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    })
}

fn variable(token: &str) -> Option<(&str, &str)> {
    if let Some(rest) = token.strip_prefix('%') {
        return rest.split_once('%');
    }
    let rest = token.strip_prefix('$')?;
    if let Some(rest) = rest.strip_prefix('{') {
        let (name, tail) = rest.split_once('}')?;
        return Some((name.strip_prefix("env:").unwrap_or(name), tail));
    }
    let rest = if rest
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("env:"))
    {
        &rest[4..]
    } else {
        rest
    };
    let end = rest
        .find(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .unwrap_or(rest.len());
    Some((&rest[..end], &rest[end..]))
}

fn real_or_nearest(path: &Path) -> PathBuf {
    if let Ok(real) = crate::secure_fs::canonicalize(path) {
        return real;
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                current.pop();
            }
            other => current.push(other.as_os_str()),
        }
    }
    let mut suffix = Vec::new();
    loop {
        if let Ok(real) = crate::secure_fs::canonicalize(&current) {
            return suffix
                .into_iter()
                .rev()
                .fold(real, |path, part| path.join(part));
        }
        let Some(name) = current.file_name().map(std::borrow::ToOwned::to_owned) else {
            return current;
        };
        suffix.push(name);
        if !current.pop() {
            return path.to_path_buf();
        }
    }
}
