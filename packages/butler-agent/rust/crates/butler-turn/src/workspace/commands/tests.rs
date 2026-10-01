use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};

use tokio::io::AsyncWrite;
use tokio::process::{Child, Command};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

use super::process::{
    CaptureSink, GroupSignal, ProcessFuture, ProcessHost, signal_pid, spawn_contained,
};
use super::{
    CommandError, CommandStep, Commands, GuidedAccess, GuidedCommandInput, StructuredCommandInput,
};

/// Real processes with the conditions the lifecycle tests depend on made
/// deterministic: a child that ignores SIGTERM from the first instant, a
/// child that is not reaped until the test releases it, a pause before a
/// pipeline step spawns, and a spool writer that fails.
#[derive(Default)]
struct ScriptedProcesses {
    ignore_term: bool,
    reaping: Option<watch::Receiver<bool>>,
    before_second_spawn: Option<Arc<Notify>>,
    spawns: AtomicUsize,
    failing_capture: bool,
}

impl ScriptedProcesses {
    fn reaping_released(&self) -> bool {
        self.reaping
            .as_ref()
            .is_none_or(|reaping| *reaping.borrow())
    }

    fn reaped_on_release() -> (Self, watch::Sender<bool>) {
        let (release, reaping) = watch::channel(false);
        let host = Self {
            ignore_term: true,
            reaping: Some(reaping),
            ..Self::default()
        };
        (host, release)
    }
}

impl ProcessHost for ScriptedProcesses {
    fn spawn<'a>(&'a self, command: &'a mut Command) -> ProcessFuture<'a, std::io::Result<Child>> {
        Box::pin(async move {
            if self.spawns.fetch_add(1, Ordering::SeqCst) == 1
                && let Some(gate) = &self.before_second_spawn
            {
                gate.notified().await;
            }
            spawn_contained(command).await
        })
    }

    fn signal_group(&self, pid: u32, signal: GroupSignal) -> Result<(), CommandError> {
        if self.ignore_term && signal == GroupSignal::Terminate {
            return Ok(());
        }
        signal_pid(pid, signal)
    }

    fn wait<'a>(
        &'a self,
        child: &'a mut Child,
    ) -> ProcessFuture<'a, std::io::Result<std::process::ExitStatus>> {
        Box::pin(async move {
            if let Some(reaping) = &self.reaping {
                let _ = reaping.clone().wait_for(|released| *released).await;
            }
            child.wait().await
        })
    }

    fn try_wait(&self, child: &mut Child) -> std::io::Result<Option<std::process::ExitStatus>> {
        if !self.reaping_released() {
            return Ok(None);
        }
        child.try_wait()
    }

    fn capture_sink(&self, file: tokio::fs::File) -> CaptureSink {
        if self.failing_capture {
            Box::new(FailingSink)
        } else {
            Box::new(file)
        }
    }
}

struct FailingSink;

impl AsyncWrite for FailingSink {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Poll::Ready(Err(std::io::Error::other("spool device full")))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("butler-native-commands-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn guided(&self, command: &str) -> GuidedCommandInput {
        let mut host_environment = HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
        if let Some(home) = butler_platform::user_dirs::home_dir() {
            host_environment.insert("HOME".into(), home.to_string_lossy().into_owned());
        }
        GuidedCommandInput {
            command: command.into(),
            cwd: None,
            workspace_root: self.0.clone(),
            butler_data: self.0.clone(),
            timeout_ms: None,
            access: GuidedAccess::FullAccessContained,
            host_environment,
            abort: CancellationToken::new(),
        }
    }
    fn structured(&self, steps: Vec<CommandStep>) -> StructuredCommandInput {
        StructuredCommandInput {
            steps,
            cwd: Some(self.0.clone()),
            environment: HashMap::new(),
            host_environment: HashMap::new(),
            inherit_environment: false,
            stdin: String::new(),
            timeout_ms: None,
            abort: CancellationToken::new(),
            legacy: None,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Pure-logic table: incremental UTF-8 decoding of command output matches the
/// source oracle at every chunk boundary.
// test-category: pure-logic
#[test]
fn bun_incremental_decoder_oracle_matches_chunk_boundaries() {
    let oracle: serde_json::Value = serde_json::from_str(include_str!("source-bun.json")).unwrap();
    for case in oracle["utf8Chunks"].as_array().unwrap() {
        let mut decoder = super::decode::Utf8Decoder::default();
        let mut text = String::new();
        for chunk in case["chunks"].as_array().unwrap() {
            let bytes: Vec<u8> = chunk
                .as_array()
                .unwrap()
                .iter()
                .map(|value| u8::try_from(value.as_u64().unwrap()).unwrap_or(u8::MAX))
                .collect();
            decoder.write(&bytes, &mut text);
        }
        decoder.end(&mut text);
        assert_eq!(text, case["text"]);
    }
}

/// Race: dropping the caller's future while the owner holds the child does
/// not cancel the child.
// test-category: race
#[tokio::test]
async fn caller_drop_does_not_cancel_owned_child() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let marker = fixture.0.join("done");
    let command = format!("sleep 0.05; printf x > '{}'", marker.display());
    drop(owner.submit_guided(fixture.guided(&command)).unwrap());
    butler_test_support::eventually("the dropped command to finish", || {
        owner.active_count() == 0
    })
    .await;
    assert_eq!(std::fs::read(&marker).unwrap(), b"x");
    owner.close().await;
    assert_eq!(owner.active_count(), 0);
}

#[tokio::test]
async fn structured_utf8_fragments_and_spawn_failure() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let output = owner
        .submit_structured(fixture.structured(vec![CommandStep {
            executable: "/bin/sh".into(),
            arguments: vec![
                "-c".into(),
                "printf '\\342'; sleep 0.02; printf '\\202\\254'".into(),
            ],
        }]))
        .unwrap()
        .await
        .unwrap();
    assert_eq!(output.stdout, "€");
    let failed = owner
        .submit_structured(fixture.structured(vec![CommandStep {
            executable: "/definitely/missing/butler-command".into(),
            arguments: vec![],
        }]))
        .unwrap()
        .await
        .unwrap();
    assert_eq!(failed.error.unwrap().code(), "command_spawn_failed");
    assert_eq!(failed.exit_code, None);
    owner.close().await;
}

mod lifecycle;
