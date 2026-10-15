//! Physical grant discovery and per-run policy files, off runtime workers.
mod tools;
use super::{Error, helper};
use crate::command_sandbox::{
    Invocation, SandboxError,
    mxc_policy::{WinPath, environment, policy::Plan},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::os::windows::fs::OpenOptionsExt;
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Serialize, Deserialize)]
pub(super) struct PolicyFile {
    pub pid: u32,
    pub started: u64,
    pub data: PathBuf,
    pub project: PathBuf,
    pub scratch: PathBuf,
    pub git_settings: BTreeMap<String, String>,
    pub request: Value,
}
pub(super) fn physical(path: &Path) -> Result<WinPath, Error> {
    physical_for(path, "physical grant")
}
pub(super) fn physical_for(path: &Path, category: &str) -> Result<WinPath, Error> {
    resolve_physical(path).map_err(|error| {
        WinPath::rejection(&path.to_string_lossy(), category, &error.to_string()).into()
    })
}
fn resolve_physical(path: &Path) -> Result<WinPath, Error> {
    let final_path = dunce::canonicalize(path)?;
    let normalized = WinPath::new(final_path.to_str().ok_or("non_unicode_path")?)?;
    // Case-sensitive Windows directories must never turn a grant or denial
    // into another entry when the portable comparison spelling is normalized.
    if !same_file::is_same_file(&final_path, normalized.as_str())? {
        return Err("ambiguous_final_path".into());
    }
    Ok(normalized)
}

pub(in crate::command_sandbox) fn invocation(
    invocation: Invocation,
    host: &HashMap<String, String>,
    root: &Path,
    writable: &[&Path],
    denied: &[&Path],
) -> Result<Invocation, SandboxError> {
    prepare(invocation, host, root, writable, denied)
        .map_err(|e| SandboxError::Filesystem(std::io::Error::other(e.to_string())))
}
fn prepare(
    invocation: Invocation,
    host: &HashMap<String, String>,
    root: &Path,
    writable: &[&Path],
    denied: &[&Path],
) -> Result<Invocation, Error> {
    let mut env: BTreeMap<String, String> = host
        .iter()
        .map(|(k, v)| (k.to_ascii_uppercase(), v.clone()))
        .collect();
    let data = PathBuf::from(environment::get(&env, "BUTLER_DATA").ok_or("BUTLER_DATA required")?);
    for dir in writable {
        fs::create_dir_all(dir)?;
    }
    normalize_host_roots(&mut env)?;
    let project = physical_for(root, "project")?;
    let tools = tools::discover(&env)?;
    for key in ["CARGO_HOME", "RUSTUP_HOME"] {
        if let Some(value) = tools.environment.get(key) {
            env.insert(key.into(), value.clone());
        }
    }
    let credentials = environment::credential_roots(&env)?
        .into_iter()
        .filter(|p| Path::new(p.as_str()).exists())
        .map(|p| physical_for(Path::new(p.as_str()), "credential denial"))
        .collect::<Result<Vec<_>, _>>()?;
    let secrets = denied
        .iter()
        .filter(|p| p.starts_with(root))
        .map(|p| physical_for(p, "project secret denial"))
        .collect::<Result<Vec<_>, _>>()?;
    let plan = Plan {
        project,
        data: physical_for(&data, "BUTLER_DATA")?,
        host_environment: env.clone(),
        tools,
        secrets,
        credentials,
    };
    if writable
        .iter()
        .map(|p| physical_for(p, "writable scratch"))
        .collect::<Result<Vec<_>, _>>()?
        != plan.scratch()?
    {
        return Err("unexpected_scratch_roots".into());
    }
    let timeout = environment::get(&env, "BUTLER_COMMAND_TIMEOUT_MS")
        .ok_or("timeout required")?
        .parse()?;
    let mut request = plan.build(&invocation, 'Z', timeout)?;
    canonical_grants(&mut request)?;
    let path = save_policy(&data, root, &env, &plan, request)?;
    Ok(Invocation {
        program: helper()?.to_string_lossy().into(),
        arguments: vec![
            "--policy-file".into(),
            path.to_string_lossy().into(),
            "--".into(),
            invocation.program,
        ]
        .into_iter()
        .chain(invocation.arguments)
        .collect(),
    })
}
fn normalize_host_roots(env: &mut BTreeMap<String, String>) -> Result<(), Error> {
    for key in [
        "SYSTEMROOT",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "BUTLER_DATA",
        "CARGO_HOME",
        "RUSTUP_HOME",
    ] {
        if let Some(value) = env.get(key).filter(|s| !s.is_empty()).cloned() {
            env.insert(
                key.into(),
                physical_for(Path::new(&value), key)?.as_str().into(),
            );
        }
    }
    Ok(())
}
fn canonical_grants(request: &mut Value) -> Result<(), Error> {
    for field in ["readwritePaths", "readonlyPaths", "deniedPaths"] {
        let paths = request
            .get_mut("filesystem")
            .and_then(|v| v.get_mut(field))
            .and_then(Value::as_array_mut)
            .ok_or("invalid paths")?;
        let mut resolved = Vec::new();
        for path in paths.iter() {
            let path = Path::new(path.as_str().ok_or("invalid path")?);
            if path.exists() {
                resolved.push(serde_json::to_value(physical_for(path, field)?)?);
            } else if field == "readwritePaths" {
                return Err("writable grant missing".into());
            }
        }
        *paths = resolved;
    }
    Ok(())
}
fn redirect_scratch(request: &mut Value, root: &WinPath, scratch: &WinPath) {
    if let Some(env) = request
        .pointer_mut("/process/env")
        .and_then(Value::as_array_mut)
    {
        for entry in env {
            if let Some(text) = entry.as_str() {
                let (from, to) = if text.starts_with("HOMEPATH=") {
                    (
                        root.as_str().get(2..).unwrap_or_default(),
                        scratch.as_str().get(2..).unwrap_or_default(),
                    )
                } else {
                    (root.as_str(), scratch.as_str())
                };
                *entry = text.replace(from, to).into();
            }
        }
    }
}

fn save_policy(
    data: &Path,
    root: &Path,
    env: &BTreeMap<String, String>,
    plan: &Plan,
    mut request: Value,
) -> Result<PathBuf, Error> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let scratch = data.join("tmp/project-write").join(&id);
    fs::create_dir(&scratch)?;
    redirect_scratch(
        &mut request,
        plan.scratch()?.first().ok_or("missing scratch")?,
        &physical(&scratch)?,
    );
    let (pid, started) = super::drive::identity()?;
    let payload = PolicyFile {
        pid,
        started,
        data: dunce::canonicalize(data)?,
        project: dunce::canonicalize(root)?,
        scratch,
        git_settings: tools::git_settings(env, &plan.tools)?,
        request,
    };
    let directory = data.join("sandbox/policies");
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{id}.json"));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(0)
        .open(&path)?;
    serde_json::to_writer(&file, &payload)?;
    file.sync_all()?;
    Ok(path)
}

pub(super) fn reconcile_policies(data: &Path) -> std::io::Result<()> {
    let directory = data.join("sandbox/policies");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let scratch_root = data.join("tmp/project-write");
    for entry in entries {
        let entry = entry?;
        if entry.path().extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let bytes = match fs::read(entry.path()) {
            Ok(bytes) => bytes,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(32) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        let payload: PolicyFile = match serde_json::from_slice(&bytes) {
            Ok(payload) => payload,
            Err(_) => {
                ignore_missing(fs::remove_file(entry.path()))?;
                continue;
            }
        };
        if super::drive::start_time(payload.pid)? == Some(payload.started) {
            continue;
        }
        if let Ok(scratch) = dunce::canonicalize(&payload.scratch)
            && scratch.parent() == Some(dunce::canonicalize(&scratch_root)?.as_path())
        {
            ignore_missing(fs::remove_dir_all(scratch))?;
        }
        ignore_missing(fs::remove_file(entry.path()))?;
    }
    Ok(())
}

fn ignore_missing(result: std::io::Result<()>) -> std::io::Result<()> {
    match result {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}
