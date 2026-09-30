//! Healthy HTTP must not release startup before the same child is lifecycle-ready.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{
    HarnessError,
    agent::{Agent, Launch},
    executable,
    sandbox::Sandbox,
};
use std::{fs, process::Command, time::Duration};

#[tokio::test]
async fn harness_waits_for_current_child_lifecycle_readiness() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let sandbox = Sandbox::new("HARNESS-READY")?;
    let launch = fixture_launch(&sandbox)?;
    let mut starting = Box::pin(Agent::start(launch));
    loop {
        tokio::select! {
            result = &mut starting => panic!("harness returned before lifecycle readiness: {}", result.is_ok()),
            () = tokio::time::sleep(Duration::from_millis(10)) => {
                if sandbox.data.join("healthy-observed").exists() { break; }
            }
        }
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut starting)
            .await
            .is_err(),
        "HTTP health released startup while the instance was still starting"
    );
    let path = sandbox.data.join("state/butler-agent-native-service.json");
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
    assert_eq!(record["state"], "starting");
    let pid = record["pid"].clone();
    record["state"] = "ready".into();
    record["pid"] = 0.into();
    fs::write(&path, serde_json::to_vec(&record)?)?;
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut starting)
            .await
            .is_err(),
        "another child's ready record released startup"
    );
    record["pid"] = pid;
    fs::write(path, serde_json::to_vec(&record)?)?;
    let (agent, gateway) = starting.await?;
    assert_eq!(record["pid"], agent.pid().expect("running fixture"));
    assert_eq!(record["app_endpoint"], gateway.base);
    assert!(gateway.healthy().await);
    drop(agent);
    Ok(())
}

fn fixture_launch(sandbox: &Sandbox) -> Result<Launch, HarnessError> {
    let python = Command::new("python3")
        .args(["-c", "import sys; print(sys.executable)"])
        .output()?;
    assert!(python.status.success());
    let interpreter = String::from_utf8(python.stdout).expect("interpreter path");
    let mut launch = Launch::new(sandbox)?;
    launch.binary = sandbox.root.join("ready-fixture");
    executable::write_script(
        &launch.binary,
        &format!(
            "#!{}\n{}",
            interpreter.trim(),
            include_str!("fixtures/ready_service.py")
        ),
    )?;
    Ok(launch)
}
