//! Safe Landlock trampoline; never restrict the multithreaded agent itself.
pub(super) mod complement;
mod generated;
mod links;
mod mountns;
mod process;
mod rediscovery;
mod seccomp;
mod timing;
pub(super) mod unresolved;
#[cfg(feature = "test-support")]
pub use mountns::verify_mount_plan_contract;

use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use landlock::{
    ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, Ruleset, RulesetAttr,
    RulesetCreated, RulesetStatus, Scope,
};
use serde::{Deserialize, Serialize};

use super::host_capabilities::unavailable;
use super::project_secrets::discover_project_secrets;
use super::{Invocation, Level, ProtectError, Protection, SandboxCapabilities, SandboxError};

type Error = Box<dyn std::error::Error>;

#[derive(Serialize, Deserialize)]
struct Policy {
    denied: Vec<PathBuf>,
    credentials: Vec<PathBuf>,
    allowed: Vec<PathBuf>,
    tcp: bool,
    project: Option<PathBuf>,
    writable: Vec<PathBuf>,
    write_denied: Vec<PathBuf>,
    #[serde(default)]
    mountns: bool,
    #[serde(default)]
    mountns_plus: bool,
    #[serde(skip)]
    secrets: Vec<PathBuf>,
    #[serde(skip)]
    mask_scopes: Vec<PathBuf>,
    /// Other mount views of the writable roots, withheld as a whole.
    #[serde(skip)]
    views: Vec<PathBuf>,
    /// Device of each mount target, read before any mask is mounted.
    #[serde(skip)]
    mounts: HashMap<PathBuf, u64>,
}

fn helper() -> std::io::Result<PathBuf> {
    static HELPER: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    HELPER
        .get_or_init(|| locate_helper().ok())
        .clone()
        .ok_or_else(|| std::io::Error::other("no sandbox helper path"))
}

fn locate_helper() -> std::io::Result<PathBuf> {
    #[cfg(feature = "test-support")]
    if let Some(path) = std::env::var_os("NEXTEST_BIN_EXE_butler-sandbox")
        .or_else(|| std::env::var_os("NEXTEST_BIN_EXE_butler_sandbox"))
    {
        return Ok(PathBuf::from(path));
    }
    let executable = std::env::current_exe()?;
    let parent = executable
        .parent()
        .ok_or_else(|| std::io::Error::other("no executable parent"))?;
    #[cfg(feature = "test-support")]
    let parent = if parent.file_name().is_some_and(|name| name == "deps") {
        parent
            .parent()
            .ok_or_else(|| std::io::Error::other("no profile directory"))?
    } else {
        parent
    };
    Ok(parent.join("butler-sandbox"))
}

pub(super) fn probe() -> SandboxCapabilities {
    if !abi_available(3)
        || Ruleset::default()
            .set_compatibility(CompatLevel::HardRequirement)
            .handle_access(AccessFs::from_all(ABI::V3))
            .and_then(Ruleset::create)
            .is_err()
    {
        return unavailable("Landlock ABI v3 is required");
    }
    let Ok(helper) = helper() else {
        return unavailable("butler-sandbox helper is missing");
    };
    if !helper.is_file() {
        return unavailable("butler-sandbox helper is missing");
    }
    let tcp = tcp_available();
    let seccomp = Command::new(helper)
        .arg("--probe-seccomp")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    SandboxCapabilities {
        read_only: if !seccomp {
            Level::Partial("metadata seccomp unavailable")
        } else if !ioctl_available() {
            Level::Partial("Landlock device ioctl restriction requires ABI v5")
        } else if !scopes_available() {
            Level::Partial("Landlock signal and abstract socket scoping requires ABI v6")
        } else {
            Level::Enforced
        },
        process_scoping: if scopes_available() {
            Level::Enforced
        } else {
            Level::Unavailable("Landlock signal and abstract socket scoping requires ABI v6")
        },
        network_deny: if seccomp {
            Level::Enforced
        } else if tcp {
            Level::Partial("TCP only")
        } else {
            Level::Unavailable("seccomp and Landlock TCP unavailable")
        },
        private_reads: Level::Partial(
            "private root contents denied; project regular secrets at top level; directory names and secret symlinks need lexical guard",
        ),
        write_protection: Level::Unavailable("Linux protected roots are deferred"),
        project_write: if seccomp && scopes_available() && ioctl_available() {
            if mountns::available() {
                Level::Enforced
            } else {
                Level::Partial(mountns::reason())
            }
        } else {
            Level::Unavailable("project writes require Landlock ABI v6 and network denial")
        },
    }
}

fn abi_available(required: u32) -> bool {
    #[cfg(feature = "test-support")]
    if std::env::var("BUTLER_TEST_LANDLOCK_ABI")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .is_some_and(|abi| abi < required)
    {
        return false;
    }
    let _ = required;
    true
}

fn tcp_available() -> bool {
    static TCP: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *TCP.get_or_init(|| {
        Ruleset::default()
            .set_compatibility(CompatLevel::HardRequirement)
            .handle_access(AccessNet::from_all(ABI::V4))
            .and_then(Ruleset::create)
            .is_ok()
    })
}

// Probe individual optional rights with hard requirements; never silently
// drop a boundary and report it as enforced. No probe restricts this thread.
fn ioctl_available() -> bool {
    static IOCTL: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *IOCTL.get_or_init(|| {
        abi_available(5)
            && Ruleset::default()
                .set_compatibility(CompatLevel::HardRequirement)
                .handle_access(AccessFs::IoctlDev)
                .and_then(Ruleset::create)
                .is_ok()
    })
}

fn scopes_available() -> bool {
    static SCOPES: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SCOPES.get_or_init(|| {
        abi_available(6)
            && Ruleset::default()
                .set_compatibility(CompatLevel::HardRequirement)
                .handle_access(AccessFs::from_all(ABI::V3))
                .and_then(|rules| rules.scope(Scope::Signal | Scope::AbstractUnixSocket))
                .and_then(Ruleset::create)
                .is_ok()
    })
}

fn ruleset(tcp: bool) -> Result<RulesetCreated, Error> {
    // Admission requires all these rights. The child repeats the hard
    // requirement, never re-probes or silently degrades an admitted policy.
    let mut rules = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(ABI::V5))?
        .scope(Scope::Signal | Scope::AbstractUnixSocket)?;
    if tcp {
        rules = rules.handle_access(AccessNet::from_all(ABI::V4))?;
    }
    Ok(rules.create()?)
}

pub(super) fn read_only_contained(
    invocation: Invocation,
    environment: &HashMap<String, String>,
    denied: &[&Path],
    allowed: &[&Path],
) -> Result<Invocation, SandboxError> {
    if !super::capabilities().read_only.is_enforced() {
        return Err(SandboxError::ReadOnlyUnavailable);
    }
    let policy = Policy {
        denied: denied.iter().map(|path| path.to_path_buf()).collect(),
        credentials: super::credentials::roots(environment),
        allowed: allowed.iter().map(|path| path.to_path_buf()).collect(),
        tcp: tcp_available(),
        project: None,
        writable: Vec::new(),
        write_denied: Vec::new(),
        mountns: false,
        mountns_plus: false,
        secrets: Vec::new(),
        mask_scopes: Vec::new(),
        views: Vec::new(),
        mounts: HashMap::new(),
    };
    let mut arguments = vec![
        "--policy".into(),
        serde_json::to_string(&policy)?,
        "--".into(),
        invocation.program,
    ];
    arguments.extend(invocation.arguments);
    Ok(Invocation {
        program: helper()
            .map_err(|_| SandboxError::ReadOnlyUnavailable)?
            .to_string_lossy()
            .into_owned(),
        arguments,
        ..Default::default()
    })
}

pub(super) fn protect_writes(
    invocation: Invocation,
    _root: &Path,
) -> Result<Protection, ProtectError> {
    Ok(Protection::Unavailable(invocation))
}

pub(super) fn project_write(
    invocation: Invocation,
    environment: &HashMap<String, String>,
    root: &Path,
    writable: &[&Path],
    denied: &[&Path],
    _toolchain_roots: Option<&crate::command_sandbox::ToolchainRoots>,
) -> Result<Invocation, SandboxError> {
    if !super::project_write_available() {
        return Err(SandboxError::ProjectWriteUnavailable);
    }
    let real = crate::secure_fs::canonicalize(root)?;
    // The helper inventories project secrets immediately before containment.
    // Do not repeat a potentially huge inventory in the exec argument block.
    let mut walk = rediscovery::Rediscovery::new(root, &real)?;
    let denied: Vec<_> = denied
        .iter()
        .copied()
        .filter(|path| !walk.reaches(path))
        .collect();
    let policy = Policy {
        // Outside reads match ReadOnly. Denials of existing project secrets
        // retain both their lexical path and resolved aliases in complement.
        denied: denied
            .iter()
            .filter(|path| path.starts_with(root) || path.starts_with(&real))
            .map(|path| path.to_path_buf())
            .collect(),
        write_denied: denied.iter().map(|path| path.to_path_buf()).collect(),
        credentials: super::credentials::roots(environment),
        allowed: vec![real.clone()],
        tcp: tcp_available(),
        project: Some(real),
        mountns: mountns::available(),
        mountns_plus: mountns::tier() == mountns::Tier::MPlus,
        secrets: Vec::new(),
        mask_scopes: Vec::new(),
        views: Vec::new(),
        mounts: HashMap::new(),
        writable: writable
            .iter()
            .map(crate::secure_fs::canonicalize)
            .collect::<Result<_, _>>()?,
    };
    let mut arguments = vec![
        "--policy".into(),
        serde_json::to_string(&policy)?,
        "--".into(),
        invocation.program,
    ];
    arguments.extend(invocation.arguments);
    Ok(Invocation {
        program: helper()
            .map_err(|_| SandboxError::ProjectWriteUnavailable)?
            .to_string_lossy()
            .into_owned(),
        arguments,
        ..Default::default()
    })
}

pub(super) fn trampoline() -> Result<(), Error> {
    let mut timing = timing::Timing::new();
    let mut arguments = std::env::args().skip(1);
    match arguments.next().as_deref() {
        Some("--probe-seccomp") => return seccomp::apply(false),
        Some("--probe-mountns-child") => return mountns::probe_child(),
        Some("--probe-mountns") => {
            match mountns::tier() {
                mountns::Tier::MPlus => println!("M+"),
                mountns::Tier::M => println!("M"),
                mountns::Tier::L => println!("L {}", mountns::reason()),
            }
            return Ok(());
        }
        Some("--policy") => {}
        _ => return Err("expected --policy".into()),
    }
    let mut policy: Policy = serde_json::from_str(&arguments.next().ok_or("missing policy")?)?;
    if arguments.next().as_deref() != Some("--") {
        return Err("missing command separator".into());
    }
    let program = arguments.next().ok_or("missing program")?;
    timing.mark("policy_parse");
    if let Some(root) = &policy.project {
        // The parent sends only denials the walk cannot rediscover; resolve
        // those fully, and discovered entries only where they are symlinks.
        let secrets = complement::entry_aliases(discover_project_secrets(root)?)?;
        timing.mark("project_secrets");
        policy.denied = complement::aliases(&policy.denied)?;
        policy.write_denied = complement::aliases(&policy.write_denied)?;
        policy.credentials = complement::aliases(&policy.credentials)?;
        policy.denied.extend(secrets.iter().cloned());
        policy.write_denied.extend(secrets.iter().cloned());
        policy.secrets = secrets;
    } else {
        for root in &policy.allowed {
            policy.denied.extend(complement::project_secrets(root)?);
        }
        timing.mark("project_secrets");
        policy.denied = complement::aliases(&policy.denied)?;
        policy.credentials = complement::aliases(&policy.credentials)?;
    }
    timing.mark("credential_aliases");
    mountns::expand_views(&mut policy)?;
    timing.mark("expand_views");
    let tier = install_policy(&policy, &mut timing)?;
    timing.report(tier);
    // Dropped already by tool_environment; also remove it for direct invocations.
    let mut command = Command::new(program);
    if let Some(root) = &policy.project {
        command.env(
            "GIT_CEILING_DIRECTORIES",
            root.parent().ok_or("project has no parent")?,
        );
    }
    let error = command.args(arguments).env_remove("WSL_INTEROP").exec();
    Err(error.into())
}

pub(super) fn prepare_project_write(
    root: &Path,
    data: &Path,
) -> std::io::Result<super::ProjectWritePreparation> {
    generated::prepare(root, data)
}

fn install_policy(policy: &Policy, timing: &mut timing::Timing) -> Result<mountns::Tier, Error> {
    let cwd = std::env::current_dir()?;
    if policy.project.is_some() {
        links::validate(policy)?;
    }
    let masked = if policy.mountns && policy.project.is_some() {
        mountns::mask(policy).ok()
    } else {
        None
    };
    let mounted = masked.is_some();
    // M+ only adds read-only mounts; a failure keeps M's metadata denial.
    let sealed = masked
        .flatten()
        .is_some_and(|sealing| sealing.seal(&policy.views).is_ok());
    if policy.mountns {
        // The old cwd may name the unmasked mount below new ones, even after
        // a partial mask that fell back to Tier L.
        nix::unistd::chdir(&cwd)?;
    }
    let mut rules = ruleset(policy.tcp)?;
    timing.mark("ruleset_and_mounts");
    let hidden: Vec<_> = if mounted {
        policy
            .secrets
            .iter()
            .chain(&policy.views)
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    complement::apply(
        &mut rules,
        &policy.denied,
        &policy.allowed,
        &policy.credentials,
        &hidden,
        &policy.mounts,
        timing,
    )?;
    if policy.project.is_some() {
        complement::project_write(&mut rules, policy, mounted, &policy.mounts)?;
    }
    timing.mark("project_write");
    let status = rules.restrict_self()?;
    timing.mark("restrict_self");
    if status.ruleset != RulesetStatus::FullyEnforced || !status.no_new_privs {
        return Err("Landlock was not fully enforced".into());
    }
    seccomp::apply(sealed)?;
    timing.mark("seccomp");
    Ok(match (mounted, sealed) {
        (true, true) => mountns::Tier::MPlus,
        (true, false) => mountns::Tier::M,
        _ => mountns::Tier::L,
    })
}

#[cfg(feature = "test-support")]
pub(super) fn project_mount_aliases(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    mountns::project_aliases(root).map_err(|error| std::io::Error::other(error.to_string()))
}

pub(super) fn cleanup_generated(root: &Path, data: &Path) -> std::io::Result<()> {
    generated::cleanup(root, data, false)
}

pub(super) fn remember_probe(data: &Path) {
    mountns::remember(data);
}

pub(super) fn mount_tier_available() -> bool {
    mountns::available()
}

pub(super) fn metadata_tier_available() -> bool {
    mountns::tier() == mountns::Tier::MPlus
}
