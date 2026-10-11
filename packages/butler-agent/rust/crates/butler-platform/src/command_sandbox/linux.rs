//! Safe Landlock trampoline; never restrict the multithreaded agent itself.
mod complement;
mod network;

use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use landlock::{
    ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, Ruleset, RulesetAttr,
    RulesetCreated, RulesetStatus,
};
use serde::{Deserialize, Serialize};

use super::host_capabilities::unavailable;
use super::{Invocation, Level, ProtectError, Protection, SandboxCapabilities, SandboxError};

type Error = Box<dyn std::error::Error>;

#[derive(Serialize, Deserialize)]
struct Policy {
    denied: Vec<PathBuf>,
    allowed: Vec<PathBuf>,
    network: bool,
    tcp: bool,
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
    let mut parent = executable
        .parent()
        .ok_or_else(|| std::io::Error::other("no executable parent"))?;
    if parent.file_name().is_some_and(|name| name == "deps") {
        parent = parent
            .parent()
            .ok_or_else(|| std::io::Error::other("no profile directory"))?;
    }
    Ok(parent.join("butler-sandbox"))
}

pub(super) fn probe() -> SandboxCapabilities {
    if abi_capped_below_v3() || ruleset(false).is_err() {
        return unavailable("Landlock ABI v3 is required");
    }
    let Ok(helper) = helper() else {
        return unavailable("butler-sandbox helper is missing");
    };
    if !helper.is_file() {
        return unavailable("butler-sandbox helper is missing");
    }
    let tcp = tcp_available();
    let network = Command::new(helper)
        .arg("--probe-network")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    SandboxCapabilities {
        read_only: Level::Enforced,
        network_deny: if network {
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
    }
}

fn abi_capped_below_v3() -> bool {
    #[cfg(feature = "test-support")]
    if std::env::var("BUTLER_TEST_LANDLOCK_ABI")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .is_some_and(|abi| abi < 3)
    {
        return true;
    }
    false
}

fn tcp_available() -> bool {
    static TCP: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *TCP.get_or_init(|| ruleset(true).is_ok())
}

fn ruleset(tcp: bool) -> Result<RulesetCreated, Error> {
    let mut rules = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(ABI::V3))?;
    if tcp {
        rules = rules.handle_access(AccessNet::from_all(ABI::V4))?;
    }
    Ok(rules.create()?)
}

pub(super) fn read_only(invocation: Invocation) -> Result<Invocation, SandboxError> {
    read_only_contained(invocation, &HashMap::new(), &[], &[])
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
    let denied = complement::private_roots(environment, denied, allowed);
    let policy = Policy {
        denied,
        allowed: allowed.iter().map(|path| path.to_path_buf()).collect(),
        network: super::capabilities().network_deny.is_enforced(),
        tcp: tcp_available(),
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
    })
}

pub(super) fn protect_writes(
    invocation: Invocation,
    _root: &Path,
) -> Result<Protection, ProtectError> {
    Ok(Protection::Unavailable(invocation))
}

pub(super) fn trampoline() -> Result<(), Error> {
    let mut arguments = std::env::args().skip(1);
    match arguments.next().as_deref() {
        Some("--probe-network") => return network::apply(),
        Some("--policy") => {}
        _ => return Err("expected --policy".into()),
    }
    let policy: Policy = serde_json::from_str(&arguments.next().ok_or("missing policy")?)?;
    if arguments.next().as_deref() != Some("--") {
        return Err("missing command separator".into());
    }
    let program = arguments.next().ok_or("missing program")?;
    let mut rules = ruleset(policy.tcp)?;
    complement::apply(&mut rules, &policy.denied, &policy.allowed)?;
    let status = rules.restrict_self()?;
    if status.ruleset != RulesetStatus::FullyEnforced || !status.no_new_privs {
        return Err("Landlock was not fully enforced".into());
    }
    if policy.network {
        network::apply()?;
    }
    // Dropped already by tool_environment; also remove it for direct invocations.
    let error = Command::new(program)
        .args(arguments)
        .env_remove("WSL_INTEROP")
        .exec();
    Err(error.into())
}
