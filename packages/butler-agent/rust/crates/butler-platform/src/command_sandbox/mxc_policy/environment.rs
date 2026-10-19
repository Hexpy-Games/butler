//! Explicit scratch environment layered on sanitized tool_environment output.
use super::{WinPath, toolchain::Toolchain};
use std::collections::BTreeMap;

/// Case-insensitive environment lookup, independent of the executing host.
pub fn get<'a>(env: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}
/// Creates the environment; file generation and wrappers are PR2 helper work.
pub fn build(
    host: &BTreeMap<String, String>,
    scratch: &WinPath,
    tools: &Toolchain,
    cwd: &WinPath,
) -> Result<BTreeMap<String, String>, &'static str> {
    let system = get(host, "SYSTEMROOT").ok_or("SYSTEMROOT required")?;
    WinPath::new(system)?;
    get(host, "LOCALAPPDATA").ok_or("LOCALAPPDATA required")?;
    let home = scratch.join("home")?;
    let mut env = BTreeMap::new();
    for key in [
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "CARGO_HOME",
        "RUSTUP_HOME",
    ] {
        if let Some(value) = get(host, key) {
            env.insert(key.into(), value.into());
        }
    }
    for (key, value) in [
        ("USERPROFILE", home.clone()),
        ("HOME", home.clone()),
        ("APPDATA", home.join("AppData\\Roaming")?),
        ("LOCALAPPDATA", home.join("AppData\\Local")?),
        ("TEMP", scratch.join("t")?),
        ("TMP", scratch.join("t")?),
        ("GIT_CONFIG_GLOBAL", scratch.join("gitconfig")?),
        ("NPM_CONFIG_USERCONFIG", scratch.join("npmrc")?),
        ("NPM_CONFIG_CACHE", scratch.join("npm-cache")?),
        ("BUTLER_COMMAND_CWD", cwd.clone()),
    ] {
        env.insert(key.into(), value.as_str().into());
    }
    env.insert("HOMEDRIVE".into(), home.as_str()[..2].into());
    env.insert("HOMEPATH".into(), home.as_str()[2..].into());
    for (key, value) in [
        ("CARGO_NET_OFFLINE", "true"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("NPM_CONFIG_OFFLINE", "true"),
        ("PYTHONIOENCODING", "utf-8"),
        ("PYTHONUTF8", "1"),
    ] {
        env.insert(key.into(), value.into());
    }
    let mut path = vec![scratch.join("bin")?];
    path.extend(tools.path.clone());
    env.insert(
        "PATH".into(),
        path.iter()
            .map(WinPath::as_str)
            .collect::<Vec<_>>()
            .join(";"),
    );
    env.extend(tools.environment.clone());
    Ok(env)
}
/// Only the approved host Git settings may reach the generated scratch config.
pub fn git_config(
    settings: &BTreeMap<String, String>,
    drive: char,
) -> Result<String, &'static str> {
    if !drive.is_ascii_alphabetic() {
        return Err("invalid project drive");
    }
    let mut text = String::new();
    for key in [
        "user.name",
        "user.email",
        "core.autocrlf",
        "core.eol",
        "init.defaultBranch",
    ] {
        if let Some(value) = settings.get(key) {
            if value.contains(['\0', '\n', '\r']) {
                return Err("invalid Git setting");
            }
            let (section, name) = key.split_once('.').ok_or("invalid Git key")?;
            text.push_str(&format!(
                "[{section}]\n{name} = \"{}\"\n",
                value.replace('\\', "\\\\").replace('"', "\\\"")
            ));
        }
    }
    text.push_str(&format!(
        "[core]\nfsmonitor = false\n[commit]\ngpgsign = false\n[safe]\ndirectory = {}:/\n",
        drive.to_ascii_uppercase()
    ));
    Ok(text)
}
/// Windows credential paths, collected before redirecting the profile.
pub fn credential_roots(env: &BTreeMap<String, String>) -> Result<Vec<WinPath>, String> {
    let mut roots = Vec::new();
    if let Some(home) = get(env, "USERPROFILE").or_else(|| get(env, "HOME")) {
        let home = WinPath::categorized(home, "USERPROFILE/HOME")?;
        for name in [
            ".ssh",
            ".aws",
            ".azure",
            ".kube",
            ".docker",
            ".gnupg",
            ".git-credentials",
            ".npmrc",
            "_netrc",
            ".netrc",
            ".pypirc",
            ".cargo\\credentials",
            ".cargo\\credentials.toml",
            ".codex\\auth.json",
            ".config\\gh",
            ".config\\gcloud",
        ] {
            roots.push(home.join(name)?);
        }
    }
    if let Some(app) = get(env, "APPDATA") {
        let app = WinPath::categorized(app, "APPDATA")?;
        for name in [
            "Microsoft\\Credentials",
            "Microsoft\\Protect",
            "gh",
            "GitHub CLI",
            "gcloud",
        ] {
            roots.push(app.join(name)?);
        }
    }
    if let Some(local) = get(env, "LOCALAPPDATA") {
        roots.push(WinPath::categorized(local, "LOCALAPPDATA")?.join("Microsoft\\Credentials")?);
    }
    for (key, name) in [
        ("CARGO_HOME", "credentials"),
        ("CARGO_HOME", "credentials.toml"),
        ("CODEX_HOME", "auth.json"),
        ("BUTLER_DATA", "auth"),
        ("BUTLER_DATA", "sandbox-quarantine"),
    ] {
        if let Some(root) = get(env, key) {
            roots.push(WinPath::categorized(root, key)?.join(name)?);
        }
    }
    for key in ["GH_CONFIG_DIR", "CLOUDSDK_CONFIG"] {
        if let Some(path) = get(env, key).filter(|p| !p.is_empty()) {
            roots.push(WinPath::categorized(path, key)?);
        }
    }
    if let Some(root) = get(env, "XDG_CONFIG_HOME").filter(|p| !p.is_empty()) {
        roots.push(WinPath::categorized(root, "XDG_CONFIG_HOME")?.join("gh")?);
    }
    if let Some(path) = get(env, "CODEX_AUTH_JSON").filter(|p| !p.is_empty()) {
        roots.push(WinPath::categorized(path, "CODEX_AUTH_JSON")?);
    }
    if let Some(data) = get(env, "BUTLER_DATA") {
        let data = WinPath::categorized(data, "BUTLER_DATA")?;
        for path in crate::data_paths::GATEWAY_CREDENTIALS {
            roots.push(data.join(path)?);
        }
        for key in ["BUTLER_CODEX_AUTH_PROFILE", "BUTLER_OPENAI_AUTH_PROFILE"] {
            if let Some(path) = get(env, key).filter(|p| !p.is_empty()) {
                let resolved = WinPath::new(path)
                    .or_else(|_| data.join(path))
                    .map_err(|reason| WinPath::rejection(path, key, reason))?;
                roots.push(resolved);
            }
        }
    }
    Ok(roots)
}
