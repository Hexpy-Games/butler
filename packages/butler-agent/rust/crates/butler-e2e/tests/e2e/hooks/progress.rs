//! A tool row whose transcript publication fails never vanishes silently.
use super::*;

/// The post-tool hook parks the turn after its tool result is journaled and
/// before the row is published, so the BTCC write lock fails exactly that write.
#[tokio::test]
async fn hooks_unpublished_tool_row_interrupts_turn_and_retry_delivers() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = Setup::new("HOOK-PROGRESS-BUSY")?.synthetic(Script {
        rounds: 1,
        path_for: Box::new(|_| "progress-input.txt".into()),
        final_text: "Done.".into(),
    });
    fs::write(
        setup.sandbox.data.join("progress-input.txt"),
        "Exact tool content",
    )?;
    let held = setup.sandbox.home.join("hook-held");
    let release = setup.sandbox.home.join("hook-release");
    configure(
        &setup,
        &[
            json!({"id":"hold","event":"PostToolUse","type":"command","args":fixture(&setup,"hold"),
        "timeout_ms":60000,"env":{"HOOK_HELD":held,"HOOK_RELEASE":release}}),
        ],
    )?;
    let s = setup.start().await?;
    // Declared after the scenario so it drops first: every exit path, panics
    // included, releases a held hook before the agent stops.
    let mut release = Release(Some(release));
    let accepted =
        s.gw.say("general", "Read progress-input.txt, then finish.")
            .await?;
    let turn_id = s.gw.accepted_turn(&accepted).await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while !held.exists() {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    // Wait out the agent's own short write transactions; the hold below
    // starts only once this lock is ours.
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("BEGIN IMMEDIATE")?;
    release.now()?;
    // Hold the lock until the turn reports the interruption: the row's append
    // fails once the BTCC writer's 5 s lock wait runs out, however long the
    // agent takes to reach it after the hook returns. Then release: later
    // writes succeed, and a dropped row would have let the turn deliver.
    let locked = Instant::now();
    let deadline = locked + Duration::from_secs(30);
    let interrupted = format!("interrupted turn_id={turn_id} ");
    while !s.agent.logs().contains(&interrupted) {
        if Instant::now() >= deadline {
            db.execute_batch("ROLLBACK")?;
            panic!(
                "turn was not interrupted while its row append was locked out:\n{}",
                s.agent.logs()
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    db.execute_batch("ROLLBACK")?;
    drop(db);
    eprintln!("PROGRESS-BUSY lock held {:?}", locked.elapsed());
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn["state"], "failed", "{turn}");
    assert_eq!(turn["safe_error_code"], "turn_interrupted", "{turn}");
    assert_eq!(turn["retryable"], true, "{turn}");
    // The loop stopped at the unpublished row instead of asking for another round.
    assert_eq!(s.provider()?.timings().len(), 1, "{}", s.agent.logs());
    let retry =
        s.gw.post(&format!("/turns/{turn_id}/retry"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    s.gw.wait_turn("general", &turn_id, &["delivered"], Duration::from_secs(30))
        .await?;
    s.finish().await
}

/// Writes the hook's release file once: explicitly, or when dropped.
struct Release(Option<std::path::PathBuf>);

impl Release {
    fn now(&mut self) -> std::io::Result<()> {
        if let Some(path) = &self.0 {
            fs::write(path, b"")?;
        }
        self.0 = None;
        Ok(())
    }
}

impl Drop for Release {
    fn drop(&mut self) {
        if let Err(error) = self.now() {
            eprintln!("hook release failed: {error}");
        }
    }
}
