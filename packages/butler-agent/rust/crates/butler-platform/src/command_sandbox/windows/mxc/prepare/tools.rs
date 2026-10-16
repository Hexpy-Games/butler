//! Cached toolchain discovery, with canonical install evidence.
use super::{Error, physical, physical_for};
use crate::command_sandbox::ToolchainRoots;
use crate::command_sandbox::mxc_policy::{
    WinPath, environment,
    toolchain::{self, Discovery, Toolchain},
};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    process::Command,
    sync::{Mutex, OnceLock},
};

type ToolCache = Option<(BTreeMap<String, String>, Option<ToolchainRoots>, Toolchain)>;

pub(super) fn discover(
    env: &BTreeMap<String, String>,
    account: Option<&ToolchainRoots>,
) -> Result<Toolchain, Error> {
    static CACHE: OnceLock<Mutex<ToolCache>> = OnceLock::new();
    let key: BTreeMap<_, _> = env
        .iter()
        .filter(|(k, _)| !k.starts_with("BUTLER_") && !k.starts_with("CODEX_"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "toolchain_cache_poisoned")?;
    if let Some((_, _, tools)) = cache
        .as_ref()
        .filter(|(cached, roots, _)| cached == &key && roots.as_ref() == account)
    {
        return refresh_credentials(tools.clone());
    }
    let tools = collect(env, account)?;
    *cache = Some((key, account.cloned(), tools.clone()));
    refresh_credentials(tools)
}
fn root(env: &BTreeMap<String, String>, key: &str) -> Result<Option<WinPath>, Error> {
    environment::get(env, key)
        .filter(|v| !v.is_empty())
        .map(|v| physical_for(Path::new(v), key))
        .transpose()
}
fn collect(
    env: &BTreeMap<String, String>,
    account: Option<&ToolchainRoots>,
) -> Result<Toolchain, Error> {
    let mut input = Discovery {
        system_root: root(env, "SYSTEMROOT")?,
        app_data: account
            .as_ref()
            .and_then(|a| physical(&a.app_data).ok())
            .or(root(env, "APPDATA")?),
        local_app_data: account
            .as_ref()
            .and_then(|a| physical(&a.local_app_data).ok())
            .or(root(env, "LOCALAPPDATA")?),
        cargo_home: root(env, "CARGO_HOME")?,
        rustup_home: root(env, "RUSTUP_HOME")?,
        ..Discovery::default()
    };
    for key in ["PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"] {
        if let Some(root) = root(env, key)? {
            input.program_files.push(root);
        }
    }
    let home = account
        .as_ref()
        .and_then(|a| physical(&a.home).ok())
        .or(root(env, "USERPROFILE")?)
        .ok_or("profile required")?;
    input.user_profile = Some(home.clone());
    if input.cargo_home.is_none() {
        input.cargo_home = existing(&home.join(".cargo")?);
    }
    if input.rustup_home.is_none() {
        input.rustup_home = existing(&home.join(".rustup")?);
    }
    for base in [
        Some(home.clone()),
        input.app_data.clone(),
        input.local_app_data.clone(),
    ]
    .into_iter()
    .flatten()
    {
        for relative in [
            "scoop\\apps",
            "nvm",
            ".nvm",
            "Author Software\\nvm",
            "Microsoft\\WinGet\\Packages",
        ] {
            let expected = base.join(relative)?;
            if existing(&expected).as_ref() == Some(&expected) {
                input.install_roots.push(expected);
            }
        }
    }
    add_path(env, &mut input)?;
    super::tools::msvc::discover(env, &mut input)?;
    let mut tools = toolchain::discover(&input)?;
    for (key, path) in [
        ("CARGO_HOME", input.cargo_home),
        ("RUSTUP_HOME", input.rustup_home),
    ] {
        if let Some(path) = path {
            tools.environment.insert(key.into(), path.as_str().into());
        }
    }
    Ok(tools)
}
fn existing(path: &WinPath) -> Option<WinPath> {
    physical(Path::new(path.as_str())).ok()
}

type SettingsCache = Option<(String, BTreeMap<String, String>)>;
pub(super) fn git_settings(
    env: &BTreeMap<String, String>,
    tools: &Toolchain,
) -> Result<BTreeMap<String, String>, Error> {
    static CACHE: OnceLock<Mutex<SettingsCache>> = OnceLock::new();
    let Some(cmd) = tools.path.iter().find(|p| p.as_str().ends_with("\\cmd")) else {
        return Ok(BTreeMap::new());
    };
    let git = cmd.join("git.exe")?;
    let key = format!(
        "{};{}",
        git.as_str(),
        environment::get(env, "USERPROFILE").unwrap_or_default()
    );
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "git_cache_poisoned")?;
    if let Some((_, settings)) = cache.as_ref().filter(|(cached, _)| cached == &key) {
        return Ok(settings.clone());
    }
    let result = Command::new(git.as_str())
        .args([
            "config",
            "--global",
            "--get-regexp",
            "^(user\\.(name|email)|core\\.(autocrlf|eol)|init\\.defaultBranch)$",
        ])
        .env_clear()
        .envs(env)
        .output()?;
    let mut settings = BTreeMap::new();
    if result.status.success() {
        for line in String::from_utf8(result.stdout)?.lines() {
            let (name, value) = line.split_once(' ').ok_or("invalid_git_setting")?;
            if [
                "user.name",
                "user.email",
                "core.autocrlf",
                "core.eol",
                "init.defaultbranch",
            ]
            .contains(&name)
            {
                let name = if name == "init.defaultbranch" {
                    "init.defaultBranch"
                } else {
                    name
                };
                settings.insert(name.into(), value.into());
            }
        }
    } else if result.status.code() != Some(1) {
        return Err("git_config_failed".into());
    }
    *cache = Some((key, settings.clone()));
    Ok(settings)
}

mod msvc;

mod search_path;
use search_path::add_path;

// Installation discovery is cached; credential names and token-bearing
// configuration are current at each admission, with no idle polling.
fn refresh_credentials(mut tools: Toolchain) -> Result<Toolchain, Error> {
    let Some(cargo) = tools.environment.get("CARGO_HOME").cloned() else {
        return Ok(tools);
    };
    let cargo = Path::new(&cargo);
    let config = physical(cargo)?.join("config")?;
    let toml = physical(cargo)?.join("config.toml")?;
    tools.denied.retain(|p| p != &config && p != &toml);
    for entry in fs::read_dir(cargo)? {
        let entry = entry?;
        if entry
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .starts_with("credentials")
        {
            let path = physical(&entry.path())?;
            if !tools.denied.contains(&path) {
                tools.denied.push(path);
            }
        }
    }
    for path in [config, toml] {
        if Path::new(path.as_str()).exists()
            && fs::read_to_string(path.as_str())?
                .to_ascii_lowercase()
                .contains("token")
        {
            tools.denied.push(path);
        }
    }
    Ok(tools)
}
