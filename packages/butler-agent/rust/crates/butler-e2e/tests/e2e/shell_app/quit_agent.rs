use butler_platform::process_control::{Liveness, liveness};

use super::*;

/// SHELL-APP-18 — Quitting the App ends its Agent and starts no other: after the shell exits, the
/// Agent it started is gone and no instance with another nonce ever appears.
#[tokio::test]
async fn shell_app_18_quit_leaves_no_agent_running() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-18")?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell.run(&["agent running"]).await?;
    let record = instance_record(&sandbox.data).expect("instance record");
    let nonce = record["nonce"].clone();
    let pid = u32::try_from(record["pid"].as_u64().expect("pid")).expect("pid");
    shell.finish().await?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        let record = instance_record(&sandbox.data);
        if let Some(r) = &record
            && r["nonce"] != nonce
        {
            panic!("another Agent started after quit: {r}");
        }
        if liveness(pid) == Liveness::Gone
            && record.as_ref().is_none_or(|r| {
                liveness(u32::try_from(r["pid"].as_u64().expect("pid")).expect("pid"))
                    == Liveness::Gone
            })
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        liveness(pid),
        Liveness::Gone,
        "the App's Agent outlived quit"
    );
    sandbox.mark_success();
    Ok(())
}
