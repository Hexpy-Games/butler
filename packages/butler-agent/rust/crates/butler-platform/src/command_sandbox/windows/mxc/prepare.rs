//! Physical grant discovery and per-run policy files, off runtime workers.
mod tools;
use super::{Error, helper};
use crate::command_sandbox::{
    Invocation, SandboxError,
    mxc_policy::{WinPath, environment, policy::Plan},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Serialize, Deserialize)]
pub(super) struct PolicyFile {
    pub data: PathBuf,
    pub project: PathBuf,
    pub scratch: PathBuf,
    pub git_settings: BTreeMap<String, String>,
    pub request: Value,
}
pub(super) fn physical(path: &Path) -> Result<WinPath, Error> {
    Ok(WinPath::new(
        dunce::canonicalize(path)?
            .to_str()
            .ok_or("non_unicode_path")?,
    )?)
}
pub(super) fn invocation(
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
            env.insert(key.into(), physical(Path::new(&value))?.as_str().into());
        }
    }
    let project = physical(root)?;
    let tools = tools::discover(&env)?;
    let credentials = environment::credential_roots(&env)?
        .into_iter()
        .filter(|p| Path::new(p.as_str()).exists())
        .map(|p| physical(Path::new(p.as_str())))
        .collect::<Result<Vec<_>, _>>()?;
    let secrets = denied
        .iter()
        .filter(|p| p.starts_with(root))
        .map(|p| physical(p))
        .collect::<Result<Vec<_>, _>>()?;
    let plan = Plan {
        project,
        data: physical(&data)?,
        host_environment: env.clone(),
        tools,
        secrets,
        credentials,
    };
    if writable
        .iter()
        .map(|p| physical(p))
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
fn canonical_grants(request: &mut Value) -> Result<(), Error> {
    for field in ["readwritePaths", "readonlyPaths", "deniedPaths"] {
        let paths = request["filesystem"][field]
            .as_array_mut()
            .ok_or("invalid paths")?;
        let mut resolved = Vec::new();
        for path in paths.iter() {
            let path = Path::new(path.as_str().ok_or("invalid path")?);
            if path.exists() {
                resolved.push(serde_json::to_value(physical(path)?)?);
            } else if field == "readwritePaths" {
                return Err("writable grant missing".into());
            }
        }
        *paths = resolved;
    }
    Ok(())
}
fn redirect_scratch(request: &mut Value, root: &WinPath, scratch: &WinPath) {
    if let Some(env) = request["process"]["env"].as_array_mut() {
        for entry in env {
            if let Some(text) = entry.as_str() {
                *entry = text.replace(root.as_str(), scratch.as_str()).into();
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
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let scratch = data.join("tmp/project-write").join(&id);
    fs::create_dir(&scratch)?;
    redirect_scratch(&mut request, &plan.scratch()?[0], &physical(&scratch)?);
    let payload = PolicyFile {
        data: dunce::canonicalize(&data)?,
        project: dunce::canonicalize(root)?,
        scratch,
        git_settings: tools::git_settings(&env)?,
        request,
    };
    let directory = data.join("sandbox/policies");
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{id}.json"));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    serde_json::to_writer(&file, &payload)?;
    file.sync_all()?;
    Ok(path)
}
