//! SVC-01-PORT: a foreign listener must reject startup before any disk writes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{HarnessError, agent::Launch, sandbox::Sandbox, scenario::Setup};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

#[tokio::test]
async fn svc_01_port_in_use_fails_start_without_disk_changes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SVC-01-PORT")?.start().await?;
    let stopped = s.agent.cli_reaping(&["stop", "--json"]).await?;
    assert_eq!(stopped.code, Some(0), "{}", stopped.stderr);
    s.agent.reap();
    assert_conflict_is_read_only(&s.agent.launch)?;
    // Releasing the foreign port must leave the original service startable.
    s.gw = s.agent.start_again().await?;
    s.finish().await
}

#[tokio::test]
async fn svc_01_fresh_port_conflict_creates_no_files() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SVC-01-PORT-FRESH")?.start().await?;
    // Supervisor retries reuse the installed executable. Keep that identity
    // while testing an entirely empty DATA, rather than timing the first
    // execution of another 515 MB debug-binary copy under load.
    let mut launch = s.agent.launch.clone();
    launch.data = s.sandbox.root.join("fresh-data");
    fs::create_dir(&launch.data)?;
    launch.use_data_folder_token();
    let blocker = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    launch.port = blocker.local_addr()?.port();
    assert_eq!(snapshot(&launch.data)?.len(), 1);
    assert_failed_start(&launch)?;
    drop(blocker);
    s.finish().await
}

fn assert_conflict_is_read_only(launch: &Launch) -> Result<(), HarnessError> {
    let blocker = std::net::TcpListener::bind(("127.0.0.1", launch.port))?;
    // Model a supervisor's repeated attempts against an already used data dir.
    for _ in 0..3 {
        assert_failed_start(launch)?;
    }
    drop(blocker);
    Ok(())
}

fn assert_failed_start(launch: &Launch) -> Result<(), HarnessError> {
    let before = snapshot(&launch.data)?;
    let began = Instant::now();
    let (code, text) = run_bounded(launch, Duration::from_secs(5))?;
    let elapsed = began.elapsed();
    assert!(code.is_some_and(|code| code != 0), "exit {code:?}: {text}");
    assert!(text.contains("app_listener_bind_failed"), "{text}");
    let address = format!("127.0.0.1:{}", launch.port);
    assert!(text.contains(&address), "missing {address}: {text}");
    assert_eq!(
        snapshot(&launch.data)?,
        before,
        "failed startup changed data files"
    );
    eprintln!(
        "port conflict rejected in {} ms; {} entries unchanged",
        elapsed.as_millis(),
        before.len()
    );
    Ok(())
}

// Include directories, sizes and bytes as well as the required file list and
// mtimes: transient creation/deletion also changes the containing directory.
type Snapshot = BTreeMap<PathBuf, (SystemTime, u64, Option<Vec<u8>>)>;
fn snapshot(root: &Path) -> Result<Snapshot, HarnessError> {
    let mut result = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = fs::metadata(&path)?;
        let bytes = if metadata.is_dir() {
            for entry in fs::read_dir(&path)? {
                pending.push(entry?.path());
            }
            None
        } else {
            Some(fs::read(&path)?)
        };
        result.insert(
            path.strip_prefix(root)
                .expect("snapshot stays under root")
                .to_path_buf(),
            (metadata.modified()?, metadata.len(), bytes),
        );
    }
    Ok(result)
}

/// Runs the actual supervised service entrypoint, with no CLI admission writes.
fn run_bounded(launch: &Launch, limit: Duration) -> Result<(Option<i32>, String), HarnessError> {
    let log = launch.logs.join("bounded.log");
    let file = fs::File::create(&log)?;
    let mut child = launch
        .command()
        .stdin(std::process::Stdio::null())
        .stdout(file.try_clone()?)
        .stderr(file)
        .spawn()?;
    let deadline = Instant::now() + limit;
    let code = loop {
        if let Some(status) = child.try_wait()? {
            break status.code();
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    Ok((code, fs::read_to_string(log)?))
}

#[tokio::test]
async fn harness_argv_port_zero_binds_an_ephemeral_listener() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let sandbox = Sandbox::new("SVC-01-PORT-ARGV")?;
    let launch = Launch::new(&sandbox)?;
    let mut command = tokio::process::Command::from(launch.command());
    command
        .env_remove("BUTLER_APP_SERVER_PORT")
        .arg("--port=0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let record = loop {
        if let Some(record) = butler_e2e::e2e::stop_intent::instance_record(&sandbox.data)
            .filter(|record| record["state"] == "ready")
        {
            break record;
        }
        assert!(
            child.try_wait()?.is_none(),
            "argv port-zero service exited during startup"
        );
        assert!(
            Instant::now() < deadline,
            "argv port-zero service did not become ready"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let endpoint = record["app_endpoint"].as_str().expect("bound App URL");
    let url = reqwest::Url::parse(endpoint).expect("valid bound App URL");
    assert!(url.port().is_some_and(|port| port > 0 && port != 18765));
    // Read-only status on the stopped case and control-backed status above
    // exercise the shared zero semantics; this proves the argv bind itself.
    child.kill().await?;
    child.wait().await?;
    Ok(())
}
