//! Recent feedback via production chat transport, with deterministic replay.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    dead_code,
    reason = "E2E assertions and shared helpers"
)]
#[path = "feedback/support.rs"]
mod feedback_support;
use butler_e2e::e2e::HarnessError;
use feedback_support::*;
#[tokio::test]
async fn feedback_scopes_cross_chat_and_restart_without_policy_truncation()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start("FEEDBACK-SCOPES").await?;
    let (id, a) = project(&s, "Feedback project").await?;
    let b = project_chat(&s, &id, "Second chat").await?;
    let (_, outside) = project(&s, "Other project").await?;
    for (chat, user) in [
        (&a, "Correct globally"),
        (&a, "Correct project"),
        (&a, "Correct session"),
    ] {
        let result = support::tool(&s, chat, user, "record_user_feedback").await?;
        assert_eq!(result["ok"], true, "{result}");
        assert!(result["feedback"].as_str().unwrap().starts_with("fb_"));
    }
    let in_a = prompt(&s, &a).await?;
    assert!(in_a.contains("SESSION feedback applies here."));
    let in_b = prompt(&s, &b).await?;
    assert!(
        in_b.contains("PROJECT feedback applies here.")
            && !in_b.contains("SESSION feedback applies here.")
    );
    let other = prompt(&s, &outside).await?;
    assert!(
        other.contains("Use the verified source, not stale results.")
            && !other.contains("PROJECT feedback applies here.")
    );
    s.restart().await?;
    let after = prompt(&s, &b).await?;
    assert!(
        after.contains("PROJECT feedback applies here.")
            && !after.contains("SESSION feedback applies here.")
    );
    for n in 0..14 {
        assert_eq!(
            support::tool(
                &s,
                "general",
                &format!("Long correction {n}"),
                "record_user_feedback"
            )
            .await?["ok"],
            true
        );
    }
    let complete = prompt(&s, &b).await?;
    for n in 0..14 {
        assert!(complete.contains(&format!("End prohibition {n}: never use stale data.")));
    }
    assert!(complete.contains("safety/privacy > current user instruction"));
    eprintln!("FEEDBACK-SCOPES complete_long_entries=14 scopes=3 restart=passed");
    s.finish().await
}

#[tokio::test]
async fn feedback_busy_lease_keeps_pending_overlay_and_unrelated_admission()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start("FEEDBACK-BUSY").await?;
    let lock = s
        .sandbox
        .data
        .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite");
    support::until(|| lock.exists()).await;
    let lease = butler_platform::sqlite::open(&lock).unwrap();
    lease.execute_batch("BEGIN IMMEDIATE").unwrap();
    let before = std::time::Instant::now();
    let output = support::tool(&s, "general", "Correct globally", "record_user_feedback").await?;
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(output["state"], "pending");
    let root = s.sandbox.data.join("cognition/feedback");
    let pending = root
        .join("pending")
        .join(format!("{}.md", output["feedback"].as_str().unwrap()));
    assert!(pending.exists());
    let b = support::new_chat(&s, "Admitted despite lease").await?;
    assert!(
        prompt(&s, &b)
            .await?
            .contains("Use the verified source, not stale results.")
    );
    eprintln!(
        "FEEDBACK-BUSY capture_and_next_turn_ms={}",
        before.elapsed().as_millis()
    );
    lease.execute_batch("ROLLBACK").unwrap();
    s.crash_and_restart().await?;
    assert!(
        prompt(&s, &b)
            .await?
            .contains("Use the verified source, not stale results.")
    );
    support::until(|| root.join("feedback.md").exists() && !pending.exists()).await;
    let text = std::fs::read_to_string(root.join("feedback.md"))?;
    assert_eq!(
        text.matches(output["feedback"].as_str().unwrap()).count(),
        1
    );
    s.finish().await
}
