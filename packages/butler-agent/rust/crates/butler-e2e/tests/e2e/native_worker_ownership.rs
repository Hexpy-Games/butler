//! The actual worker must notice owner EOF while CPU initialization is held.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::install_support;
use butler_e2e::e2e::HarnessError;
use std::{
    io::Write,
    process::Stdio,
    time::{Duration, Instant},
};

#[tokio::test]
async fn native_worker_exits_on_owner_eof_during_slow_initialization() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (sandbox, _launch) = install_support::sandbox("WORKER-OWNER-EOF")?;
    let barrier = sandbox.root.join("worker-initializing");
    let mut child = std::process::Command::new(&sandbox.binary)
        .env("BUTLER_DATA", &sandbox.data)
        .env("HOME", &sandbox.home)
        .env("BUTLER_E2E_TIER", "stub")
        .arg("--private-embedding-worker")
        .env("BUTLER_E2E_EMBED_INIT_BARRIER", &barrier)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    child.stdin.as_mut().unwrap().write_all(
        b"{\"id\":1,\"op\":\"initialize\",\"texts\":[],\"checked\":false,\"resplit\":false}\n",
    )?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !barrier.exists() {
        if let Some(status) = child.try_wait()? {
            panic!("worker exited before initialization: {status}");
        }
        if Instant::now() >= deadline {
            child.kill()?;
            child.wait()?;
            panic!("worker never initialized");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = Instant::now();
    drop(child.stdin.take());
    loop {
        if let Some(status) = child.try_wait()? {
            assert!(status.success());
            break;
        }
        if started.elapsed() >= Duration::from_secs(2) {
            child.kill()?;
            child.wait()?;
            panic!("orphaned native worker after owner EOF");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        butler_platform::instance::process_start(child.id())
            .unwrap()
            .is_none()
    );
    eprintln!(
        "native worker initializing owner EOF: {:?}, zero survivors",
        started.elapsed()
    );
    Ok(())
}
