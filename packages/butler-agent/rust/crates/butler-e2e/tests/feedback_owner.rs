//! Recent feedback controls use the authenticated owner API, without settings UI.
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
use serde_json::{Value, json};

async fn view(s: &butler_e2e::e2e::scenario::Scenario) -> Result<Value, HarnessError> {
    let reply = s.gw.get("/memory/feedback").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}
#[tokio::test]
async fn feedback_owner_inspects_edits_disables_and_deletes_without_broadening_scope()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start("FEEDBACK-OWNER").await?;
    let global = support::tool(&s, "general", "Correct globally", "record_user_feedback").await?;
    let duplicate =
        support::tool(&s, "general", "Correct globally", "record_user_feedback").await?;
    assert_eq!(duplicate["entry"]["status"], "discarded");
    assert_eq!(
        duplicate["entry"]["extra_fields"]["resolution_reason"],
        "duplicate"
    );
    assert_eq!(
        duplicate["entry"]["extra_fields"]["destination_link"],
        global["feedback"]
    );
    assert!(duplicate["entry"]["expires_at"].is_null());
    let (project_id, a) = project(&s, "Owner scope").await?;
    support::tool(&s, &a, "Correct project", "record_user_feedback").await?;
    let b = project_chat(&s, &project_id, "Same scope").await?;
    let data = view(&s).await?;
    assert_eq!(data["kind"], "recent_feedback");
    assert_eq!(data["entries"].as_array().unwrap().len(), 3);
    assert_eq!(
        data["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["status"] == "active")
            .count(),
        2
    );
    for entry in data["entries"].as_array().unwrap() {
        assert!(
            entry["text"].is_string()
                && entry["scope"].is_string()
                && entry["state"].is_string()
                && (entry["expires_at"].is_string() || entry["expires_at"].is_null())
        );
        assert!(entry.get("destination_link").is_some());
    }
    let path = format!("/memory/feedback/{}", global["feedback"].as_str().unwrap());
    let reply =
        s.gw.patch(
            &path,
            json!({"text":"Edited complete correction: use dates from the verified source."}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let new_id = reply.data()["feedback_id"].as_str().unwrap().to_owned();
    let p = prompt(&s, &b).await?;
    assert!(
        p.contains("Edited complete correction")
            && !p.contains("Use the verified source, not stale results.")
    );
    assert!(p.contains("PROJECT feedback applies here."));
    let outside = prompt(&s, "general").await?;
    assert!(
        outside.contains("Edited complete correction")
            && !outside.contains("PROJECT feedback applies here.")
    );
    let reply =
        s.gw.patch("/memory/feedback", json!({"enabled":false}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(!prompt(&s, &b).await?.contains("## Recent feedback"));
    let reply =
        s.gw.patch("/memory/feedback", json!({"enabled":true}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(prompt(&s, &b).await?.contains("Edited complete correction"));
    let reply = s.gw.delete(&format!("/memory/feedback/{new_id}")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(!prompt(&s, &b).await?.contains("Edited complete correction"));
    let canonical = std::fs::read_to_string(s.sandbox.data.join("cognition/feedback/feedback.md"))?;
    assert!(
        !canonical.contains("Edited complete correction")
            && !canonical.contains("Use the verified source, not stale results.")
    );
    assert!(canonical.contains("resolution_reason: owner_delete"));
    s.finish().await
}

#[tokio::test]
async fn feedback_reset_fences_pending_crash_receipts_and_preserves_instructions()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start("FEEDBACK-RESET").await?;
    support::tool(&s, "general", "Reusable mandate", "record_user_feedback").await?;
    let reply = s.gw.post("/memory/feedback/consolidate", json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let instructions = support::active_rules(&s.sandbox.data);
    assert_eq!(instructions.len(), 1);
    let other = support::new_chat(&s, "Reset peer").await?;
    let lock = s
        .sandbox
        .data
        .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite");
    let lease = butler_platform::sqlite::open(&lock).unwrap();
    lease.execute_batch("BEGIN IMMEDIATE").unwrap();
    let feedback = support::tool(&s, "general", "Correct globally", "record_user_feedback").await?;
    let root = s.sandbox.data.join("cognition/feedback");
    let pending = root
        .join("pending")
        .join(format!("{}.md", feedback["feedback"].as_str().unwrap()));
    let old_receipt = std::fs::read(&pending)?;
    assert!(
        view(&s).await?["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["feedback_id"] == feedback["feedback"] && entry["pending"] == true)
    );
    assert!(
        prompt(&s, &other)
            .await?
            .contains("Use the verified source, not stale results.")
    );
    lease.execute_batch("ROLLBACK").unwrap();
    let reply = s.gw.post("/memory/feedback/reset", json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(std::fs::read_dir(root.join("pending"))?.count(), 0);
    // Simulate a pre-reset receipt rename completing after reset.
    std::fs::write(&pending, old_receipt)?;
    for chat in ["general", &other] {
        assert!(!prompt(&s, chat).await?.contains("## Recent feedback"));
    }
    assert_eq!(support::active_rules(&s.sandbox.data), instructions);
    s.crash_and_restart().await?;
    assert!(!prompt(&s, &other).await?.contains("## Recent feedback"));
    let data = view(&s).await?;
    assert!(
        data["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["text"] == "")
    );
    assert_eq!(support::active_rules(&s.sandbox.data), instructions);
    s.finish().await
}

#[tokio::test]
async fn feedback_reset_during_classification_cannot_promote_old_plan() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = start("FEEDBACK-RESET-PLAN").await?;
    support::tool(&s, "general", "Reusable mandate", "record_user_feedback").await?;
    let before = s.provider()?.requests().len();
    let gate = s.provider()?.hold_next_reply("feedback_review");
    let reset = async {
        support::until(|| {
            s.provider().unwrap().requests()[before..]
                .iter()
                .any(|request| request["input"].to_string().contains("feedback_review"))
        })
        .await;
        let reply = s.gw.post("/memory/feedback/reset", json!({})).await;
        gate.release();
        reply
    };
    let (consolidated, reset) =
        tokio::join!(s.gw.post("/memory/feedback/consolidate", json!({})), reset);
    let reset = reset?;
    assert_eq!(reset.status, 200, "{}", reset.text);
    assert_eq!(consolidated?.status, 200);
    assert!(
        !s.sandbox
            .data
            .join("cognition/memory/rules/manifest.json")
            .exists()
    );
    assert!(!prompt(&s, "general").await?.contains("## Recent feedback"));
    assert!(
        view(&s).await?["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["text"] == "")
    );
    s.finish().await
}

#[tokio::test]
async fn feedback_reenable_keeps_expiry_and_malformed_entries_inactive() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = start("FEEDBACK-REENABLE").await?;
    support::tool(&s, "general", "Ephemeral feedback", "record_user_feedback").await?;
    support::tool(&s, "general", "Pinned complaint", "record_user_feedback").await?;
    let root = s.sandbox.data.join("cognition/feedback");
    support::until(|| {
        root.join("feedback.md").exists()
            && std::fs::read_dir(root.join("pending")).is_ok_and(|dir| dir.count() == 0)
    })
    .await;
    let reply =
        s.gw.patch("/memory/feedback", json!({"enabled":false}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let path = root.join("feedback.md");
    let text = std::fs::read_to_string(&path)?;
    let expired = regex::Regex::new(r"- expires_at: 2[^\n]+")
        .unwrap()
        .replace_all(&text, "- expires_at: 2000-01-01T00:00:00.000Z")
        .into_owned();
    std::fs::write(
        &path,
        format!(
            "{expired}\n## fb_malformed active\n- expires_at: invalid\n\nMalformed correction must stay inactive.\n"
        ),
    )?;
    let reply =
        s.gw.patch("/memory/feedback", json!({"enabled":true}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let p = prompt(&s, "general").await?;
    assert!(p.contains("Pinned quality complaint"));
    assert!(
        !p.contains("Seven-day correction")
            && !p.contains("Malformed correction must stay inactive")
    );
    let data = view(&s).await?;
    let malformed = data["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["feedback_id"] == "fb_malformed")
        .unwrap();
    assert_eq!(malformed["state"], "needs_clarification");
    assert_eq!(
        malformed["text"],
        "Malformed correction must stay inactive."
    );
    let reply = s.gw.post("/memory/feedback/consolidate", json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let text = std::fs::read_to_string(path)?;
    assert!(text.contains("resolution_reason: expired"));
    let data = view(&s).await?;
    let pinned = data["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["category"] == "quality_signal")
        .unwrap();
    assert_eq!(pinned["state"], "active");
    assert!(pinned["expires_at"].is_null());
    s.finish().await
}

#[tokio::test]
async fn recent_correction_overrides_saved_preference_in_the_next_peer_answer()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start("FEEDBACK-PRECEDENCE").await?;
    support::tool(
        &s,
        "general",
        "Save older preference",
        "update_explicit_memory",
    )
    .await?;
    support::tool(
        &s,
        "general",
        "Override older preference",
        "record_user_feedback",
    )
    .await?;
    let peer = support::new_chat(&s, "Precedence peer").await?;
    let p = prompt(&s, &peer).await?;
    assert!(p.contains("Prefer the old source by default."));
    assert!(p.contains("Use the verified new source for this question."));
    let messages = s.gw.messages(&peer).await?;
    assert!(
        messages
            .iter()
            .any(|message| message.to_string().contains("NEW SOURCE answer"))
    );
    s.finish().await
}

#[tokio::test]
async fn feedback_reset_generation_rejects_an_uncommitted_instruction_intent_after_restart()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = butler_e2e::e2e::scenario::Setup::new("FEEDBACK-RESET-INTENT")?
        .fixture(butler_e2e::e2e::scenario::Fixture::Empty)
        .stub_cassette(stub()?)
        .env("BUTLER_E2E_RULE_CRASH_POINTS", "1");
    let mut s = start_setup(setup).await?;
    support::tool(&s, "general", "Reusable mandate", "record_user_feedback").await?;
    let state = s.sandbox.data.join("state");
    std::fs::write(
        state.join("rule-crash-arm.json"),
        json!({"stage":"intent"}).to_string(),
    )?;
    {
        let request = s.gw.post("/memory/feedback/consolidate", json!({}));
        tokio::pin!(request);
        tokio::select! {
            reply = &mut request => panic!("returned before the intent boundary: {reply:?}"),
            () = support::until(|| state.join("rule-crash-reached.json").exists()) => {},
        }
    }
    s.agent.kill9()?;
    // Crash fixture: the reset fence is durable, but canonical cleanup was interrupted.
    std::fs::write(
        s.sandbox.data.join("cognition/feedback/generation"),
        uuid::Uuid::new_v4().to_string(),
    )?;
    s.restart().await?;
    let rules = s.sandbox.data.join("cognition/memory/rules");
    support::until(|| !rules.join("pending.json").exists()).await;
    assert!(!rules.join("manifest.json").exists());
    assert!(!prompt(&s, "general").await?.contains("## Recent feedback"));
    let data = view(&s).await?;
    assert!(
        data["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["state"] == "discarded"
                && entry["text"] == ""
                && entry["resolution_reason"] == "owner_reset")
    );
    s.finish().await
}
