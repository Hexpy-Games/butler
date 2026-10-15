//! Shared credential names and host-specific credential stores.
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::{collections::HashMap, path::PathBuf};

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
    ".project-ledger",
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
        roots.push(data.join("auth"));
        roots.push(data.join("sandbox-quarantine"));
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
