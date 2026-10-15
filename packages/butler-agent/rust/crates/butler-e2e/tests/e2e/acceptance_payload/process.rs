//! Own a dev-only real provider/storage subprocess, with file stdio and unconditional cleanup.
use super::stub;
use butler_e2e::e2e::{HarnessError, sandbox::Sandbox};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

pub(in super::super) struct Process {
    child: Child,
}
impl Process {
    pub(in super::super) fn start(
        sandbox: &Sandbox,
        endpoint: &str,
        rounds: usize,
        mode: &str,
    ) -> Result<Self, HarnessError> {
        let binary = binary()?;
        let log = std::fs::File::create(sandbox.logs.join(format!("{mode}.log")))?;
        let child = Command::new(binary)
            .args([
                sandbox.data.join("round-store.sqlite").to_str().unwrap(),
                &format!("{endpoint}/responses"),
                "openai/gpt-6-luna",
                &rounds.to_string(),
                mode,
            ])
            .env_clear()
            .env("HOME", &sandbox.home)
            .env("BUTLER_DATA", &sandbox.data)
            .env("TMPDIR", &sandbox.root)
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .spawn()?;
        Ok(Self { child })
    }
    pub(in super::super) fn kill9(&mut self) -> Result<(), HarnessError> {
        self.child.kill()?;
        self.child.wait()?;
        Ok(())
    }
    pub(in super::super) async fn finish(self) -> Result<(), HarnessError> {
        let status = self.exit().await?;
        assert!(status.success(), "round-store process failed: {status}");
        Ok(())
    }
    pub(in super::super) async fn exit(mut self) -> Result<std::process::ExitStatus, HarnessError> {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let Some(status) = self.child.try_wait()? {
                    return Ok::<_, HarnessError>(status);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn binary() -> Result<PathBuf, HarnessError> {
    if let Some(path) = std::env::var_os("BUTLER_E2E_ROUND_STORE_BIN") {
        return Ok(path.into());
    }
    if let Some(path) = std::env::var_os("NEXTEST_BIN_EXE_e2e-round-store")
        .or_else(|| std::env::var_os("NEXTEST_BIN_EXE_e2e_round_store"))
    {
        return Ok(path.into());
    }
    if let Some(path) = option_env!("CARGO_BIN_EXE_e2e-round-store") {
        return Ok(path.into());
    }
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| butler_e2e::e2e::binary::workspace_root().join("target"));
    let path = target
        .join(profile)
        .join(format!("e2e-round-store{}", std::env::consts::EXE_SUFFIX));
    if !path.exists() {
        return Err(butler_e2e::e2e::harness_error(
            "build butler-e2e --bin e2e-round-store first",
        ));
    }
    Ok(path)
}
pub(in super::super) async fn wait(
    script: &Arc<stub::Script>,
    child: &mut Process,
) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            tokio::select! {
                () = script.held.notified() => return Ok(()),
                () = tokio::time::sleep(Duration::from_millis(10)) => {
                    if let Some(status) = child.child.try_wait()? {
                        return Err(butler_e2e::e2e::harness_error(format!("round-store exited before wire capture: {status}")));
                    }
                }
            }
        }
    }).await.map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?
}
