//! Task execution through the native writer lane, in a separate process.
use butler_e2e::e2e::{HarnessError, scenario::Setup};

#[tokio::test]
async fn task_parts_review_and_completion() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("WMU-18")?.start().await?;
    s.agent.terminate().await?;
    let executable = std::env::current_exe()?
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or_else(|| std::io::Error::other("missing binary directory"))?
        .join(format!(
            "e2e-work-execution{}",
            std::env::consts::EXE_SUFFIX
        ));
    let output = tokio::process::Command::new(executable)
        .kill_on_drop(true)
        .arg(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
        .output()
        .await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    s.restart().await?;
    s.finish().await
}
