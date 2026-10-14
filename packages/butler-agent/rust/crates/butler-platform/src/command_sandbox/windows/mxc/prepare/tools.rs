//! Cached toolchain discovery, with canonical install evidence.
use super::{Error, physical};
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

type ToolCache = Option<(BTreeMap<String, String>, Toolchain)>;

pub(super) fn discover(env: &BTreeMap<String, String>) -> Result<Toolchain, Error> {
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
    if let Some((key, tools)) = cache.as_ref().filter(|(cached, _)| cached == &key) {
        let _ = key;
        return Ok(tools.clone());
    }
    let tools = collect(env)?;
    *cache = Some((key, tools.clone()));
    Ok(tools)
}
fn root(env: &BTreeMap<String, String>, key: &str) -> Result<Option<WinPath>, Error> {
    environment::get(env, key)
        .filter(|v| !v.is_empty())
        .map(|v| physical(Path::new(v)))
        .transpose()
}
fn collect(env: &BTreeMap<String, String>) -> Result<Toolchain, Error> {
    let mut input = Discovery {
        system_root: root(env, "SYSTEMROOT")?,
        app_data: root(env, "APPDATA")?,
        local_app_data: root(env, "LOCALAPPDATA")?,
        cargo_home: root(env, "CARGO_HOME")?,
        rustup_home: root(env, "RUSTUP_HOME")?,
        ..Discovery::default()
    };
    for key in ["PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"] {
        if let Some(root) = root(env, key)? {
            input.program_files.push(root);
        }
    }
    let home = root(env, "USERPROFILE")?.ok_or("profile required")?;
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
        for relative in ["scoop\\apps", "nvm\\installs", ".nvm\\installs"] {
            if let Some(root) = existing(&base.join(relative)?) {
                input.install_roots.push(root);
            }
        }
    }
    add_path(env, &mut input)?;
    if let Some(cargo) = &input.cargo_home {
        input.cargo_entries = fs::read_dir(cargo.as_str())?
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into()))
            .collect::<Result<_, _>>()?;
        for name in ["config", "config.toml"] {
            let path = Path::new(cargo.as_str()).join(name);
            if path.exists() {
                input.cargo_config_has_token |= fs::read_to_string(path)?
                    .to_ascii_lowercase()
                    .contains("token");
            }
        }
    }
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

pub(super) fn git_settings(
    env: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, Error> {
    let tools = discover(env)?;
    let Some(cmd) = tools.path.iter().find(|p| p.as_str().ends_with("\\cmd")) else {
        return Ok(BTreeMap::new());
    };
    let git = cmd.join("git.exe")?;
    let mut settings = BTreeMap::new();
    for key in [
        "user.name",
        "user.email",
        "core.autocrlf",
        "core.eol",
        "init.defaultBranch",
    ] {
        let result = Command::new(git.as_str())
            .args(["config", "--global", "--get", key])
            .env_clear()
            .envs(env)
            .output()?;
        if result.status.success() {
            settings.insert(
                key.into(),
                String::from_utf8(result.stdout)?
                    .trim_end_matches(['\r', '\n'])
                    .into(),
            );
        }
    }
    Ok(settings)
}
mod msvc;

fn add_path(env: &BTreeMap<String, String>, input: &mut Discovery) -> Result<(), Error> {
    for dir in environment::get(env, "PATH")
        .unwrap_or("")
        .split(';')
        .filter(|s| !s.is_empty())
    {
        let path = Path::new(dir);
        if !path.is_dir() {
            continue;
        }
        let lexical = WinPath::new(dir)?;
        let canonical = physical(path)?;
        if lexical.as_str().ends_with("\\windowsapps") || lexical.as_str().ends_with("\\.nodejs") {
            input.shim_dirs.push(canonical.clone());
        }
        if path.join("node.exe").is_file() && input.real_node.is_none() {
            let node = physical(&path.join("node.exe"))?
                .parent()
                .ok_or("node parent")?;
            if input
                .program_files
                .iter()
                .chain(&input.install_roots)
                .any(|r| node.is_within(r))
            {
                input.real_node = Some(node);
            }
        }
        if path.join("git.exe").is_file()
            && canonical.as_str().ends_with("\\cmd")
            && input.git_exe.is_none()
        {
            input.git_exe = Some(physical(&path.join("git.exe"))?);
        }
        input.path.push(canonical);
    }
    Ok(())
}
