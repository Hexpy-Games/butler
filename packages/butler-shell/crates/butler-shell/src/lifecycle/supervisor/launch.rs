//! Starting our child Agent (`bundled-native-agent.mjs`, `cli-installed-native-agent.mjs`, the
//! spawn environment of `app-agent-supervisor.mjs`): the command to run, a free port, and the
//! owned child whose stdin is the App's foreground lease.

use std::cmp::Ordering;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};

use butler_platform::process_control::{self, GroupSignal};
use butler_platform::secure_fs::{self, Canonical};
use butler_platform::{app_shell, launcher, user_dirs};
use serde_json::Value;
use tokio::process::{Child, ChildStdin};

use super::SupervisorError;

/// `BUTLER_APP_SERVER_PORT`'s default.
const DEFAULT_PORT: u16 = 18765;
/// `findAvailablePort` tries this many ports above the first one.
const PORT_SEARCH: u16 = 200;
/// The lowest port the search starts from.
const LOWEST_PORT: u16 = 1024;
/// The manifest beside an Agent installation (`native-agent-manifest.json`).
const MANIFEST: &str = "native-agent-manifest.json";
/// `schema` of a CLI install's manifest.
const INSTALL_SCHEMA: &str = "butler.native-agent-install.v1";
/// The packaged or CLI-installed Agent is missing or unusable.
const INSTALLATION_UNAVAILABLE: &str = "native_agent_installation_unavailable";
/// A development App without `BUTLER_NATIVE_AGENT_EXECUTABLE` (absolute).
const EXECUTABLE_UNCONFIGURED: &str = "native_agent_executable_unconfigured";

/// Where the Agent binary comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentSource {
    /// Inside the installed App's resources.
    Bundled,
    /// The CLI install under the Agent home, newer than the bundled one.
    CliInstalled,
    /// `BUTLER_NATIVE_AGENT_EXECUTABLE` (development).
    Dev,
}

/// The resolved command, environment and working folder.
#[derive(Clone, Debug)]
pub(crate) struct AgentCommand {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<OsString>,
    pub(crate) cwd: PathBuf,
    pub(crate) env: Vec<(OsString, OsString)>,
    pub(crate) version: Option<String>,
    pub(crate) source: AgentSource,
}

/// One Agent installation: its binary, its root and its resources.
struct Install {
    program: PathBuf,
    root: PathBuf,
    resources: PathBuf,
    version: Option<String>,
    source: AgentSource,
}

/// The Agent to start for `data`: the bundled one, a newer CLI install, or the dev executable.
pub(crate) fn resolve(data: &Path) -> Result<AgentCommand, SupervisorError> {
    let unavailable = SupervisorError::AgentUnavailable(INSTALLATION_UNAVAILABLE);
    let executable = std::env::current_exe().map_err(|_| unavailable)?;
    let install = match packaged_payload(&executable) {
        Some(payload) => {
            let bundled = bundled(&executable, &payload).ok_or(unavailable)?;
            prefer_newer(bundled, cli_installed())
        }
        None => dev()?,
    };
    Ok(command(data, install))
}

/// `<bundled resources>/bundled-agent`, when this App is installed.
fn packaged_payload(executable: &Path) -> Option<PathBuf> {
    let payload = app_shell::bundled_resources(executable)?.join("bundled-agent");
    payload.is_dir().then_some(payload)
}

/// `resolveBundledNativeAgentInstallation`.
fn bundled(executable: &Path, payload: &Path) -> Option<Install> {
    let program = payload.join("bin").join(launcher::AGENT_BINARY);
    let resources = payload.join("resources");
    let root = app_shell::installation_root(executable)?;
    (usable(&program, &resources) && inside(&root, &program) && inside(&root, &resources)).then(
        || Install {
            version: manifest_version(payload),
            program,
            root,
            resources,
            source: AgentSource::Bundled,
        },
    )
}

/// `resolveNativeAgentInstallation`, development branch.
fn dev() -> Result<Install, SupervisorError> {
    let configured = std::env::var("BUTLER_NATIVE_AGENT_EXECUTABLE")
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| path.is_absolute())
        .ok_or(SupervisorError::AgentUnavailable(EXECUTABLE_UNCONFIGURED))?;
    dev_install(&configured).ok_or(SupervisorError::AgentUnavailable(INSTALLATION_UNAVAILABLE))
}

fn dev_install(configured: &Path) -> Option<Install> {
    let program = configured.canonical().ok()?;
    let directory = program.parent()?;
    let root = if directory.file_name()? == "bin" {
        directory.parent()?
    } else {
        directory
    };
    let root = root.to_path_buf();
    let resources = root.join("resources");
    (usable(&program, &resources) && inside(&root, &program) && inside(&root, &resources)).then(
        || Install {
            version: manifest_version(&root),
            program,
            root,
            resources,
            source: AgentSource::Dev,
        },
    )
}

/// `resolveCliInstalledAgent`: the active CLI installation (`AGENT_HOME/current`), if usable here.
fn cli_installed() -> Option<Install> {
    let home = user_dirs::agent_home()?;
    let root = home.join("current").canonical().ok()?;
    let manifest = read_manifest(&root)?;
    let text = |key: &str| manifest.get(key).and_then(Value::as_str);
    let version = text("version")?.trim();
    if text("schema") != Some(INSTALL_SCHEMA)
        || version.is_empty()
        || text("platform") != Some(launcher::node_platform())
        || text("architecture") != Some(launcher::node_architecture())
    {
        return None;
    }
    let program = root.join("butler-agent");
    let resources = root.join("resources");
    (usable(&program, &resources) && inside(&home.canonical().ok()?, &root)).then(|| Install {
        program,
        root,
        resources,
        version: Some(version.to_owned()),
        source: AgentSource::CliInstalled,
    })
}

/// An executable file and a resources folder.
fn usable(program: &Path, resources: &Path) -> bool {
    let executable = fs::metadata(program).is_ok_and(|metadata| {
        metadata.is_file()
            && secure_fs::file_mode(&metadata).is_none_or(secure_fs::FileMode::is_executable)
    });
    executable && resources.is_dir()
}

/// `requireInside`: `child` is below `root`, never `root` itself.
fn inside(root: &Path, child: &Path) -> bool {
    secure_fs::is_within(child, root) && !secure_fs::same_path(child, root)
}

fn read_manifest(directory: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(directory.join(MANIFEST)).ok()?).ok()
}

fn manifest_version(directory: &Path) -> Option<String> {
    let manifest = read_manifest(directory)?;
    let version = manifest.get("version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_owned())
}

/// `preferNewerAgent`: the CLI install only when it is strictly newer; an unversioned bundled
/// Agent is kept.
fn prefer_newer(bundled: Install, cli: Option<Install>) -> Install {
    let newer = match (&cli, &bundled.version) {
        (Some(cli), Some(current)) => cli
            .version
            .as_deref()
            .is_some_and(|available| version_newer(available, current)),
        _ => false,
    };
    match cli {
        Some(cli) if newer => cli,
        _ => bundled,
    }
}

/// The command line and the environment the App's own Agent starts with. The port and the
/// server URL are added by [`OwnedChild::spawn`]; the Agent creates its own credential files.
fn command(data: &Path, install: Install) -> AgentCommand {
    let var = |key: &str, value: &str| (OsString::from(key), OsString::from(value));
    AgentCommand {
        args: vec![
            "--installation-root".into(),
            install.root.into_os_string(),
            "--resource-root".into(),
            install.resources.into_os_string(),
        ],
        env: vec![
            (OsString::from("BUTLER_DATA"), data.as_os_str().to_owned()),
            var("BUTLER_APP_SERVER_HOST", "127.0.0.1"),
            var("BUTLER_APP_BUNDLED_SUPERVISOR", "1"),
            var("BUTLER_APP_FOREGROUND_LEASE", "1"),
            var("BUTLER_APP_QUIT_WAIT_SAFELY", "1"),
            var("BUTLER_SHUTDOWN_TRACE", "1"),
            var("BUTLER_APP_VERSION", crate::lifecycle::APP_VERSION),
        ],
        program: install.program,
        cwd: data.to_path_buf(),
        version: install.version,
        source: install.source,
    }
}

/// SemVer precedence (`versionNewer`): is `available` newer than `current`? Unparseable is not.
fn version_newer(available: &str, current: &str) -> bool {
    let (Some((a_core, a_pre)), Some((b_core, b_pre))) = (semver(available), semver(current))
    else {
        return false;
    };
    match a_core
        .iter()
        .zip(&b_core)
        .map(|(a, b)| numeric(a, b))
        .find(|order| order.is_ne())
    {
        Some(order) => order.is_gt(),
        None => match (a_pre, b_pre) {
            (None, Some(_)) => true,
            (Some(a), Some(b)) => prerelease_newer(&a, &b),
            _ => false,
        },
    }
}

/// The three numeric parts and the prerelease identifiers of a SemVer text (build metadata is
/// ignored).
fn semver(text: &str) -> Option<([&str; 3], Option<Vec<&str>>)> {
    let (text, build) = text
        .split_once('+')
        .map_or((text, None), |(t, b)| (t, Some(b)));
    let (core, pre) = text
        .split_once('-')
        .map_or((text, None), |(c, p)| (c, Some(p)));
    let valid = |part: &str| {
        part.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    };
    if !build.is_none_or(|b| !b.is_empty() && valid(b))
        || !pre.is_none_or(|p| !p.is_empty() && valid(p))
    {
        return None;
    }
    let mut parts = core.split('.');
    let mut next = || {
        let part = parts.next()?;
        let canonical = part == "0" || (!part.starts_with('0') && !part.is_empty());
        (canonical && part.chars().all(|c| c.is_ascii_digit())).then_some(part)
    };
    let core = [next()?, next()?, next()?];
    parts
        .next()
        .is_none()
        .then(|| (core, pre.map(|p| p.split('.').collect())))
}

/// Compares two digit strings as numbers of any size.
fn numeric(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.trim_start_matches('0'), b.trim_start_matches('0'));
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

fn prerelease_newer(a: &[&str], b: &[&str]) -> bool {
    let digits = |part: &str| part.chars().all(|c| c.is_ascii_digit());
    for index in 0..a.len().max(b.len()) {
        let (Some(left), Some(right)) = (a.get(index), b.get(index)) else {
            return b.get(index).is_none();
        };
        if left == right {
            continue;
        }
        return match (digits(left), digits(right)) {
            (true, true) => numeric(left, right).is_gt(),
            (left_numeric, right_numeric) if left_numeric != right_numeric => !left_numeric,
            _ => left > right,
        };
    }
    false
}

/// `BUTLER_APP_SERVER_PORT`, else 18765, else the first free port above it.
pub(crate) fn pick_port() -> u16 {
    let base = std::env::var("BUTLER_APP_SERVER_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PORT);
    let free = |port: &u16| TcpListener::bind(("127.0.0.1", *port)).is_ok();
    if free(&base) {
        return base;
    }
    (base.saturating_add(1).max(LOWEST_PORT)..=u16::MAX)
        .take(usize::from(PORT_SEARCH))
        .find(free)
        .unwrap_or(base)
}

/// Our child Agent: its stdin is the lease, closing it is the graceful stop.
pub(crate) struct OwnedChild {
    child: Child,
    pid: u32,
    lease: Arc<Mutex<Option<ChildStdin>>>,
}

impl OwnedChild {
    /// Starts the Agent in a process group of its own with a piped stdin (the lease). Never
    /// contained in a kill-on-close Job: the App may exit while the Agent drains.
    pub(crate) fn spawn(cmd: &AgentCommand, port: u16) -> io::Result<Self> {
        let mut command = std::process::Command::new(&cmd.program);
        command
            .args(&cmd.args)
            .current_dir(&cmd.cwd)
            .envs(cmd.env.iter().map(|(key, value)| (key, value)))
            .env("BUTLER_APP_SERVER_PORT", port.to_string())
            .env("BUTLER_APP_SERVER_URL", format!("http://127.0.0.1:{port}"))
            .stdin(Stdio::piped())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        process_control::isolate_group(&mut command);
        let mut child = tokio::process::Command::from(command).spawn()?;
        let lease = child.stdin.take();
        Ok(Self {
            pid: child.id().unwrap_or(0),
            lease: Arc::new(Mutex::new(lease)),
            child,
        })
    }

    pub(crate) fn pid(&self) -> u32 {
        self.pid
    }

    pub(crate) async fn exited(&mut self) -> ExitStatus {
        self.child.wait().await.unwrap_or_default()
    }

    /// Kills the child's process group (our child only); without groups, the child itself.
    pub(crate) fn kill_tree(&mut self) {
        let grouped = process_control::SIGNALS
            && process_control::signal_group(self.pid, GroupSignal::Kill).is_ok();
        if !grouped {
            let _ = self.child.start_kill();
        }
    }

    pub(crate) fn lease_handle(&self) -> Arc<Mutex<Option<ChildStdin>>> {
        self.lease.clone()
    }
}
