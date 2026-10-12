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
        return Some((variable_name(name), tail));
    }
    let rest = variable_name(rest);
    let end = rest
        .find(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .unwrap_or(rest.len());
    Some((&rest[..end], &rest[end..]))
}

fn variable_name(name: &str) -> &str {
    if name
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("env:"))
    {
        &name[4..]
    } else {
        name
    }
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

// SSH/GPG keys, cloud/cluster logins, package registries and HTTP/Git passwords.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const COMMON_ROOTS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    ".azure",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".pypirc",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".config/gcloud",
    ".config/gh",
    ".codex/auth.json",
];
const EXACT: &[&str] = &[
    ".git",
    ".ssh",
    ".gnupg",
    "chatgpt-oauth.json",
    "credentials.json",
    "secrets.json",
    "id_rsa",
    "id_ed25519",
];
const PREFIXES: &[&str] = &[".env"];
const SUFFIXES: &[&str] = &[".pem", ".key"];

/// Whether a project path component names private metadata or credentials.
pub fn secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    EXACT.contains(&name.as_str())
        || PREFIXES.iter().any(|prefix| name.starts_with(prefix))
        || SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn roots(environment: &HashMap<String, String>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = environment.get("HOME") {
        let home = PathBuf::from(home);
        roots.extend(COMMON_ROOTS.iter().map(|name| home.join(name)));
        #[cfg(target_os = "linux")]
        roots.extend([".local/share/keyrings", ".password-store"].map(|name| home.join(name)));
        #[cfg(target_os = "macos")]
        roots.push(home.join("Library/Keychains"));
    }
    let data = environment
        .get("BUTLER_DATA")
        .map(PathBuf::from)
        .or_else(|| {
            environment
                .get("HOME")
                .map(|home| PathBuf::from(home).join(".butler"))
        });
    if let Some(data) = &data {
        roots.extend(data_credential_roots(data));
        // These general product settings also cover externally stored logins.
        // Relative Butler profile paths resolve under the configured data root.
        for key in ["BUTLER_CODEX_AUTH_PROFILE", "BUTLER_OPENAI_AUTH_PROFILE"] {
            if let Some(path) = environment.get(key).filter(|path| !path.is_empty()) {
                roots.push(data.join(path));
            }
        }
    }
    if let Some(path) = environment
        .get("CODEX_AUTH_JSON")
        .filter(|path| !path.is_empty())
    {
        let path = PathBuf::from(path);
        roots.push(std::env::current_dir().map_or_else(|_| path.clone(), |cwd| cwd.join(&path)));
    }
    if let Some(home) = environment.get("CODEX_HOME") {
        roots.push(PathBuf::from(home).join("auth.json"));
    }
    roots
}

#[cfg(target_os = "macos")]
pub(super) fn secret_pattern() -> String {
    fn escape(name: &str) -> String {
        name.replace('.', "\\.")
    }
    EXACT
        .iter()
        .map(|name| escape(name))
        .chain(PREFIXES.iter().map(|name| format!("{}[^/]*", escape(name))))
        .chain(SUFFIXES.iter().map(|name| format!("[^/]*{}", escape(name))))
        .collect::<Vec<_>>()
        .join("|")
}
