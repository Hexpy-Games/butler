//! The staged package and the installer helper (`app-package-update.mjs`): the package must sit
//! inside `<data>/updates/artifacts`, match `updates/staged/app.json` and its SHA-256, and the
//! Agent's `app-update-install` helper verifies it again, then waits on stdin for `activate`.
use std::ffi::OsString;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use butler_platform::process_control::detach;
use butler_platform::secure_fs::{self, canonicalize, is_within, same_path};
use gpui::{AsyncApp, SharedString};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::lifecycle::supervisor::launch;

/// How long the helper has to print `app-update-ready`.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_MARK: &str = "app-update-ready";

fn error(text: &str) -> SharedString {
    text.to_owned().into()
}

/// A package the App may hand to the installer.
#[derive(Clone)]
pub(super) struct Package {
    data: PathBuf,
    path: PathBuf,
}

impl Package {
    /// `safeUpdateArtifactPath` + the containment check of `prepareAppPackageUpdate`: the
    /// staged `artifact_path` is relative to the data folder and resolves inside its artifacts.
    pub(super) fn locate(staged: &Value, data: &Path) -> Result<Self, SharedString> {
        let requested = staged
            .get("artifact_path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| error("Update artifact path is required."))?;
        if Path::new(requested).is_absolute() {
            return Err(error(
                "Update artifact path must be relative to Butler data.",
            ));
        }
        let outside = || error("Update package is outside verified staging.");
        let root = canonicalize(data.join("updates").join("artifacts")).map_err(|_| outside())?;
        let path =
            canonicalize(data.join(requested)).map_err(|_| error("Update artifact is missing."))?;
        if same_path(&path, &root) || !is_within(&path, &root) {
            return Err(outside());
        }
        Ok(Self {
            data: data.to_path_buf(),
            path,
        })
    }

    /// The staged manifest must name this very file; returns its checksum.
    pub(super) fn staged_sha256(&self) -> Result<String, SharedString> {
        let manifest = std::fs::read(self.data.join("updates/staged/app.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .ok_or_else(|| error("Update package is outside verified staging."))?;
        let listed = manifest
            .get("artifact_path")
            .and_then(Value::as_str)
            .and_then(|path| canonicalize(self.data.join(path)).ok());
        let sha256 = manifest.get("sha256").and_then(Value::as_str);
        match (listed, sha256) {
            (Some(listed), Some(sha256)) if same_path(&listed, &self.path) => Ok(sha256.to_owned()),
            _ => Err(error("Update package is outside verified staging.")),
        }
    }

    /// The file's SHA-256 against the staged manifest's, read off the UI thread.
    pub(super) async fn check_sha256(
        &self,
        expected: String,
        cx: &AsyncApp,
    ) -> Result<(), SharedString> {
        let path = self.path.clone();
        let actual = cx
            .background_executor()
            .spawn(async move { sha256_hex(&path) })
            .await;
        match actual {
            Some(actual) if actual == expected => Ok(()),
            _ => Err(error("Update package checksum changed.")),
        }
    }

    /// Spawns `<agent> app-update-install <package> <exe> <pid>` and waits for it to be ready.
    pub(super) async fn start_helper(&self, cx: &AsyncApp) -> Result<Helper, SharedString> {
        let agent = launch::resolve(&self.data)
            .map_err(|failure| SharedString::from(failure.code().to_owned()))?;
        let executable =
            std::env::current_exe().map_err(|_| error("Update helper could not start."))?;
        let spec = Spec {
            program: agent.program,
            args: agent.args,
            data: self.data.clone(),
            package: self.path.clone(),
            executable,
            launch: std::env::args_os().skip(1).collect(),
        };
        cx.background_executor()
            .spawn(async move { run_helper(&spec) })
            .await
    }
}

fn sha256_hex(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            return Some(format!("{:x}", hash.finalize()));
        }
        hash.update(&buffer[..read]);
    }
}

struct Spec {
    program: PathBuf,
    args: Vec<OsString>,
    data: PathBuf,
    package: PathBuf,
    executable: PathBuf,
    launch: Vec<OsString>,
}

/// The ready installer: it activates on `activate` and gives up on end of input.
pub(super) struct Helper {
    child: Child,
}

impl Helper {
    /// Lets the helper swap the package in once this process exits.
    pub(super) fn activate(mut self) {
        if let Some(mut input) = self.child.stdin.take() {
            let _ = input.write_all(b"activate\n");
        }
        self.reap();
    }

    /// The helper stops waiting.
    pub(super) fn cancel(mut self) {
        drop(self.child.stdin.take());
        self.reap();
    }

    /// The helper is not wanted any more, even if it hangs.
    pub(super) fn abort(mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.kill();
        self.reap();
    }

    fn reap(mut self) {
        std::thread::spawn(move || {
            let _ = self.child.wait();
        });
    }
}

fn run_helper(spec: &Spec) -> Result<Helper, SharedString> {
    let updates = spec.data.join("updates");
    let failed = || error("Update helper could not start.");
    let log = secure_fs::append_private(&updates.join("app-install.log")).map_err(|_| failed())?;
    let mut mirror = log.try_clone().map_err(|_| failed())?;
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .arg("app-update-install")
        .arg(&spec.package)
        .arg(&spec.executable)
        .arg(std::process::id().to_string())
        .args(&spec.launch)
        .env("BUTLER_DATA", &spec.data)
        // A replacement starts its own Agent rather than waiting for the stopped one.
        .env_remove("BUTLER_APP_SERVER_URL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log));
    detach(&mut command);
    let mut child = command.spawn().map_err(|_| failed())?;
    let pid_file = updates.join("app-install.pid");
    let _ = std::fs::remove_file(&pid_file);
    if let Ok(mut file) = secure_fs::append_private(&pid_file) {
        let _ = file.write_all(child.id().to_string().as_bytes());
    }
    let Some(mut output) = child.stdout.take() else {
        let _ = child.kill();
        return Err(failed());
    };
    let (send, receive) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        while let Ok(read) = output.read(&mut buffer) {
            if read == 0 {
                break;
            }
            let _ = mirror.write_all(&buffer[..read]);
            if send.send(buffer[..read].to_vec()).is_err() {
                break;
            }
        }
    });
    wait_ready(child, &receive)
}

/// Waits for `app-update-ready` on the helper's output; its exit or the timeout fails.
fn wait_ready(
    mut child: Child,
    receive: &std::sync::mpsc::Receiver<Vec<u8>>,
) -> Result<Helper, SharedString> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut tail = String::new();
    let failure = loop {
        match receive.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(bytes) => {
                tail.push_str(&String::from_utf8_lossy(&bytes));
                let mut start = tail.len().saturating_sub(128);
                while !tail.is_char_boundary(start) {
                    start += 1;
                }
                tail.drain(..start);
                if tail.contains(READY_MARK) {
                    return Ok(Helper { child });
                }
            }
            Err(RecvTimeoutError::Timeout) => break "Update preparation timed out.",
            Err(RecvTimeoutError::Disconnected) => break "Update package verification failed.",
        }
    };
    drop(child.stdin.take());
    let _ = child.kill();
    let _ = child.wait();
    Err(error(failure))
}
