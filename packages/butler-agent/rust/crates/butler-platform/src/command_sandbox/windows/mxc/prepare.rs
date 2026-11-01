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
    io::Write,
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
    let final_path = crate::secure_fs::canonicalize(path)?;
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
    toolchain_roots: Option<&crate::command_sandbox::ToolchainRoots>,
) -> Result<Invocation, SandboxError> {
    prepare(invocation, host, root, writable, denied, toolchain_roots).map_err(|e| {
        if e.downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.kind() == std::io::ErrorKind::WouldBlock)
        {
            SandboxError::ProjectWritePending
        } else {
            SandboxError::Filesystem(std::io::Error::other(e.to_string()))
        }
    })
}
fn prepare(
    mut invocation: Invocation,
    host: &HashMap<String, String>,
    root: &Path,
    writable: &[&Path],
    denied: &[&Path],
    toolchain_roots: Option<&crate::command_sandbox::ToolchainRoots>,
) -> Result<Invocation, Error> {
    let _phase = super::timing::Phase::start("prepare");
    super::super::cmd::inside_utf8_bootstrap(&mut invocation);
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
    let discovery = super::timing::Phase::start("tool_discovery");
    let mut tools = tools::discover(&env, toolchain_roots)?;
    tools.path.retain(|path| !project.is_within(path));
    tools.readonly.retain(|path| !project.is_within(path));
    drop(discovery);
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
    let helper = helper()?;
    super::drive::reconcile(&data)?;
    let (path, lease) = save_policy(&data, root, &env, &plan, &invocation, timeout)?;
    Ok(Invocation {
        shell_program: None,
        shell_script: None,
        lease: Some(lease),
        program: helper.to_string_lossy().into(),
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

fn save_policy(
    data: &Path,
    root: &Path,
    env: &BTreeMap<String, String>,
    plan: &Plan,
    invocation: &Invocation,
    timeout: u32,
) -> Result<
    (
        PathBuf,
        std::sync::Arc<crate::command_sandbox::InvocationLease>,
    ),
    Error,
> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let directory = data.join(crate::data_paths::SANDBOX_POLICIES);
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{id}.json"));
    let lease = super::recovery::claim(&path)?;
    let scratch = data.join(crate::data_paths::PROJECT_WRITE_TMP).join(&id);
    fs::create_dir(&scratch)?;
    let mut scratch_guard = ScratchGuard(Some(scratch.clone()));
    let mut request = plan.build(invocation, 'Z', timeout, &physical(&scratch)?)?;
    let link_roots: Vec<_> = plan
        .scratch()?
        .iter()
        .skip(1)
        .map(|p| PathBuf::from(p.as_str()))
        .collect();
    super::ledger::admit(root, &link_roots, &plan.credentials, &plan.secrets)?;
    // Admission synchronizes both inventories immediately before policy publication.
    canonical_grants(&mut request)?;
    let (pid, started) = super::drive::identity()?;
    let payload = PolicyFile {
        pid,
        started,
        data: crate::secure_fs::canonicalize(data)?,
        project: crate::secure_fs::canonicalize(root)?,
        scratch,
        git_settings: tools::git_settings(env, &plan.tools)?,
        request,
    };
    super::launch::files(&payload, 'Z')?;
    let _phase = super::timing::Phase::start("policy_write");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(0)
        .open(&path)?;
    // This transient file is consumed on this boot, not recovered after power loss.
    let saved = serde_json::to_vec(&payload)
        .map_err(std::io::Error::other)
        .and_then(|bytes| file.write_all(&bytes));
    drop(file);
    if let Err(error) = saved {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    scratch_guard.0 = None;
    Ok((path, lease))
}

struct ScratchGuard(Option<PathBuf>);
impl Drop for ScratchGuard {
    fn drop(&mut self) {
        if let Some(path) = &self.0
            && let Err(error) = fs::remove_dir_all(path)
        {
            eprintln!("sandbox scratch cleanup failed: {error}");
        }
    }
}

pub(in crate::command_sandbox) use super::recovery::cleanup_invocation;
