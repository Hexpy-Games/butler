//! Runs a hook inside the sandbox of the session that raised its event. Anything
//! that cannot be contained does not start: there is no unsandboxed fallback.
use crate::command_sandbox::{
    self, Invocation, ProjectEntries, ProjectWritePreparation, SandboxError, ShellAccess,
    ToolchainRoots,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

/// How far a hook process may reach.
pub enum HookSandbox {
    /// Everything the user may do.
    None,
    /// Observe only: no writes, no network, no credential stores.
    ReadOnly(HookContainment),
    /// Writes inside the project and its scratch folders, no network, no credential stores.
    ProjectWrite(HookContainment),
}

/// What a sandbox is built from. The policy never comes from the hook's own
/// environment additions, so a hook cannot move what it is denied.
pub struct HookContainment {
    /// The host's environment, plus `BUTLER_DATA`: names the credential stores.
    pub policy_environment: HashMap<String, String>,
    /// The folder the hook was reviewed in.
    pub root: PathBuf,
    /// Butler's data folder.
    pub data: PathBuf,
}

/// A prepared invocation and what must be finished once its process is gone.
pub struct ContainedHook {
    /// The program to start, wrapped in its sandbox.
    pub invocation: Invocation,
    /// Scratch environment the process gets instead of the host's folders.
    pub scratch: Vec<(&'static str, String)>,
    project_write: Option<ProjectWrite>,
}

struct ProjectWrite {
    entries: ProjectEntries,
    lease: ProjectWritePreparation,
    root: PathBuf,
    data: PathBuf,
    policy_environment: HashMap<String, String>,
}

fn io_failure(error: std::io::Error) -> SandboxError {
    SandboxError::Filesystem(error)
}

/// `own` as sorted pairs: the invocation does not depend on a map's order.
fn sorted(own: &HashMap<String, String>) -> Vec<(&String, &String)> {
    let mut pairs: Vec<_> = own.iter().collect();
    pairs.sort();
    pairs
}

/// The hook as a program and arguments, before any sandbox wraps it. `own` is the
/// environment its file names. It is set by the first thing started inside the sandbox,
/// because what starts the sandbox would act on it first: a helper's loader runs
/// `LD_PRELOAD` from the project before the helper can install anything.
#[cfg(unix)]
pub fn hook_invocation(
    command: Option<&str>,
    args: Option<&[String]>,
    environment: &HashMap<String, String>,
    own: &HashMap<String, String>,
) -> Result<Invocation, SandboxError> {
    let base = match command {
        Some(text) => command_sandbox::login_shell(text, ShellAccess::Full, environment)?,
        None => {
            let args = args.unwrap_or_default();
            Invocation {
                program: args
                    .first()
                    .ok_or(SandboxError::ProjectWriteUnavailable)?
                    .clone(),
                arguments: args.get(1..).unwrap_or_default().to_vec(),
                ..Invocation::default()
            }
        }
    };
    if base.program.contains('=') {
        // `env` would read it as one more assignment.
        return Err(io_failure(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "A sandboxed hook's program path can't contain =",
        )));
    }
    let mut arguments = vec!["--".to_owned()];
    arguments.extend(
        sorted(own)
            .into_iter()
            .map(|(key, value)| format!("{key}={value}")),
    );
    arguments.push(base.program);
    arguments.extend(base.arguments);
    Ok(Invocation {
        program: "/usr/bin/env".into(),
        arguments,
        ..Invocation::default()
    })
}

/// `word` as a single-quoted PowerShell string; see [`crate::powershell_text::literal`].
pub fn powershell_literal(word: &str) -> String {
    crate::powershell_text::literal(word)
}

/// The Windows sandbox builds its own environment and launches shell scripts, so the
/// script sets `own` first, and argv becomes literal words.
#[cfg(windows)]
pub fn hook_invocation(
    command: Option<&str>,
    args: Option<&[String]>,
    environment: &HashMap<String, String>,
    own: &HashMap<String, String>,
) -> Result<Invocation, SandboxError> {
    let mut script = String::new();
    for (key, value) in sorted(own) {
        script.push_str(&format!(
            "Set-Item -LiteralPath {} -Value {}\n",
            powershell_literal(&format!("env:{key}")),
            powershell_literal(value)
        ));
    }
    if let Some(text) = command {
        script.push_str(text);
    } else {
        let args = args.unwrap_or_default();
        let program = args.first().ok_or(SandboxError::ProjectWriteUnavailable)?;
        script.push_str(&format!("& {}", powershell_literal(program)));
        for argument in args.get(1..).unwrap_or_default() {
            script.push(' ');
            script.push_str(&powershell_literal(argument));
        }
    }
    command_sandbox::login_shell(&script, ShellAccess::Full, environment)
}

fn scratch(data: &Path) -> Result<(PathBuf, PathBuf), SandboxError> {
    let temporary = data.join(crate::data_paths::PROJECT_WRITE_TMP);
    let cache = data.join(crate::data_paths::PROJECT_WRITE_CACHE);
    std::fs::create_dir_all(&temporary).map_err(io_failure)?;
    std::fs::create_dir_all(&cache).map_err(io_failure)?;
    Ok((temporary, cache))
}

/// Wraps `invocation` in the sandbox; call off async workers.
pub fn contain_hook(
    invocation: Invocation,
    sandbox: &HookSandbox,
) -> Result<ContainedHook, SandboxError> {
    match sandbox {
        HookSandbox::None => Ok(ContainedHook {
            invocation,
            scratch: Vec::new(),
            project_write: None,
        }),
        HookSandbox::ReadOnly(containment) => Ok(ContainedHook {
            invocation: command_sandbox::read_only_invocation(
                invocation,
                &containment.policy_environment,
                &containment.root,
            )?,
            scratch: Vec::new(),
            project_write: None,
        }),
        HookSandbox::ProjectWrite(containment) => project_write(invocation, containment),
    }
}

fn project_write(
    invocation: Invocation,
    containment: &HookContainment,
) -> Result<ContainedHook, SandboxError> {
    let HookContainment {
        policy_environment,
        root,
        data,
    } = containment;
    let (temporary, cache) = scratch(data)?;
    let lease = command_sandbox::prepare_project_write(root, data).map_err(io_failure)?;
    let entries = command_sandbox::discover_project_entries(root).map_err(io_failure)?;
    // A project under the data folder is admitted, and its other contents denied by default.
    let mut denied: Vec<&Path> = if crate::secure_fs::path_is_within(root, data) {
        Vec::new()
    } else {
        vec![data.as_path()]
    };
    denied.extend(entries.iter().map(PathBuf::as_path));
    let toolchain = crate::account_dirs::account_dirs().map(|dirs| ToolchainRoots {
        home: dirs.home,
        app_data: dirs.app_data,
        local_app_data: dirs.local_app_data,
    });
    let invocation = command_sandbox::project_write_invocation(
        invocation,
        policy_environment,
        root,
        &[temporary.as_path(), cache.as_path()],
        &denied,
        toolchain.as_ref(),
    )?;
    let temporary = temporary.to_string_lossy().into_owned();
    let cache = cache.to_string_lossy().into_owned();
    Ok(ContainedHook {
        invocation,
        scratch: vec![
            ("TMPDIR", temporary.clone()),
            ("TEMP", temporary.clone()),
            ("TMP", temporary),
            ("XDG_CACHE_HOME", cache),
        ],
        project_write: Some(ProjectWrite {
            entries,
            lease,
            root: root.clone(),
            data: data.clone(),
            policy_environment: policy_environment.clone(),
        }),
    })
}

impl ContainedHook {
    /// Finishes containment once the process is gone, on every exit path: secrets a
    /// run left behind are swept, and its preparation released. Call off async workers.
    pub fn finish(self) {
        if let Some(run) = self.project_write {
            let inventory = crate::secure_fs::SecretInventory::for_environment(
                &run.data,
                &run.policy_environment,
            );
            match command_sandbox::sweep_with_inventory(
                &run.root,
                &run.entries,
                &run.data,
                &inventory,
            ) {
                Ok(moved) if !moved.is_empty() => {
                    eprintln!("Hook sandbox moved {} new secret files", moved.len());
                }
                Ok(_) => {}
                Err(error) => eprintln!("Hook sandbox sweep failed: {error}"),
            }
            run.lease.release();
            if let Err(error) = command_sandbox::reconcile_project_write(&run.data) {
                eprintln!("Project write reconciliation failed: {error}");
            }
        }
        if let Err(error) = command_sandbox::cleanup_prepared_invocation(&self.invocation) {
            eprintln!("Hook sandbox cleanup failed: {error}");
        }
    }
}
