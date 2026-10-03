//! Heavy feedback routing through the production owner API.
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
use serde_json::json;

#[tokio::test]
async fn feedback_consolidation_promotes_once_and_retains_pinned_quality_hooks()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start("FEEDBACK-CONSOLIDATE").await?;
    for user in ["Reusable mandate", "Transient feedback", "Pinned complaint"] {
        assert_eq!(
            support::tool(&s, "general", user, "record_user_feedback").await?["ok"],
            true
        );
    }
    let reply = s.gw.post("/memory/feedback/consolidate", json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["status"], "completed", "{}", reply.text);
    let phases = reply.data()["phases"].as_array().unwrap();
    assert_eq!(phases.len(), 2);
    assert_eq!(phases[0]["phase"], "preflight");
    assert_eq!(phases[1]["phase"], "feedback_triage");
    assert_eq!(phases[1]["metrics"]["promoted_count"], 1);
    assert_eq!(phases[1]["metrics"]["discarded_count"], 1);
    let root = s.sandbox.data.join("cognition/feedback");
    let text = std::fs::read_to_string(root.join("feedback.md"))?;
    assert!(
        text.contains("resolution_reason: promoted"),
        "{text}; {}",
        reply.text
    );
    assert!(text.contains("resolution_reason: transient"));
    assert!(text.contains("Pinned quality complaint: that result was poor."));
    assert_eq!(support::active_rules(&s.sandbox.data).len(), 1);
    let reply = s.gw.post("/memory/feedback/consolidate", json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(support::active_rules(&s.sandbox.data).len(), 1);
    // A later capture links the already represented Instructions, instead of adding one.
    let output = support::tool(&s, "general", "Reusable mandate", "record_user_feedback").await?;
    assert_eq!(output["entry"]["status"], "discarded", "{output}");
    assert_eq!(
        output["entry"]["extra_fields"]["resolution_reason"],
        "already_represented"
    );
    assert!(output["entry"]["extra_fields"]["destination_link"].is_string());
    s.finish().await
}

#[tokio::test]
async fn feedback_retention_expiry_and_explicit_session_end() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start("FEEDBACK-RETENTION").await?;
    for (user, days) in [("Correct globally", 90), ("Ephemeral feedback", 7)] {
        let output = support::tool(&s, "general", user, "record_user_feedback").await?;
        let created =
            chrono::DateTime::parse_from_rfc3339(output["entry"]["created_at"].as_str().unwrap())
                .unwrap();
        let expires =
            chrono::DateTime::parse_from_rfc3339(output["entry"]["expires_at"].as_str().unwrap())
                .unwrap();
        assert_eq!((expires - created).num_days(), days);
    }
    let chat = support::new_chat(&s, "Session end").await?;
    let output = support::tool(&s, &chat, "Session only", "record_user_feedback").await?;
    let created =
        chrono::DateTime::parse_from_rfc3339(output["entry"]["created_at"].as_str().unwrap())
            .unwrap();
    let expires =
        chrono::DateTime::parse_from_rfc3339(output["entry"]["expires_at"].as_str().unwrap())
            .unwrap();
    assert_eq!((expires - created).num_hours(), 24);
    assert!(
        prompt(&s, &chat)
            .await?
            .contains("Session-only correction.")
    );
    let reply =
        s.gw.patch(&format!("/sessions/{chat}"), json!({"archived":true}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let reply =
        s.gw.patch(&format!("/sessions/{chat}"), json!({"archived":false}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(
        !prompt(&s, &chat)
            .await?
            .contains("Session-only correction.")
    );
    let root = s.sandbox.data.join("cognition/feedback");
    support::until(|| root.join("feedback.md").exists()).await;
    // Deterministic elapsed-time fixture: change the stored expiry, never sleep.
    let path = root.join("feedback.md");
    let text = std::fs::read_to_string(&path)?;
    let expired = regex::Regex::new(r"- expires_at: [^\n]+")
        .unwrap()
        .replace_all(&text, "- expires_at: 2000-01-01T00:00:00.000Z")
        .into_owned();
    std::fs::write(&path, expired)?;
    assert!(
        !prompt(&s, "general")
            .await?
            .contains("Seven-day correction.")
    );
    let reply = s.gw.post("/memory/feedback/consolidate", json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(std::fs::read_to_string(path)?.contains("resolution_reason: expired"));
    s.finish().await
}

#[tokio::test]
async fn feedback_profile_waits_for_consent_and_project_mandates_keep_binding()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start("FEEDBACK-PROFILE").await?;
    assert_eq!(
        support::tool(&s, "general", "Stable preference", "record_user_feedback").await?["ok"],
        true
    );
    let reply = s.gw.post("/memory/feedback/consolidate", json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let root = s.sandbox.data.join("cognition/feedback");
    assert!(
        !std::fs::read_to_string(root.join("feedback.md"))?.contains("resolution_reason: promoted")
    );
    let reply =
        s.gw.patch("/personalization", json!({"profiling":{"mode":"basic"}}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let reply = s.gw.post("/memory/feedback/consolidate", json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let text = std::fs::read_to_string(root.join("feedback.md"))?;
    assert!(
        text.contains("resolution_reason: promoted"),
        "{text}; {}",
        reply.text
    );
    assert!(text.contains("destination_link: pc_"));
    let (id, a) = project(&s, "Scoped promotion").await?;
    assert_eq!(
        support::tool(&s, &a, "Project mandate", "record_user_feedback").await?["ok"],
        true
    );
    let reply = s.gw.post("/memory/feedback/consolidate", json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let rules = support::active_rules(&s.sandbox.data);
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0]["project_id"], id);
    let b = project_chat(&s, &id, "Same project").await?;
    assert!(
        support::active_section(&s, &b, "Check applicable feedback")
            .await?
            .contains("this project's sources")
    );
    assert!(
        !support::active_section(&s, "general", "Check applicable feedback")
            .await?
            .contains("this project's sources")
    );
    s.finish().await
}

#[tokio::test]
async fn feedback_rate_limit_defers_and_resumes_without_losing_immediate_policy()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start("FEEDBACK-RATE").await?;
    support::tool(&s, "general", "Reusable mandate", "record_user_feedback").await?;
    let reply = s.gw.post("/memory/feedback/consolidate", json!({"run_id":"cr_feedback_rate","rate_budget":{"remaining_ratio":0.05,"reset_at":null}})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(
        reply.data()["status"],
        "deferred_rate_limited",
        "{}",
        reply.text
    );
    assert!(
        prompt(&s, "general")
            .await?
            .contains("Reusable mandate: always verify current sources.")
    );
    let reply = s.gw.post("/memory/feedback/consolidate", json!({"run_id":"cr_feedback_rate","resume":true,"rate_budget":{"remaining_ratio":1.0,"reset_at":null}})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(support::active_rules(&s.sandbox.data).len(), 1);
    s.finish().await
}

#[tokio::test]
async fn feedback_destination_crash_recovers_once_and_corrects_selected_instruction()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = butler_e2e::e2e::scenario::Setup::new("FEEDBACK-CRASH")?
        .fixture(butler_e2e::e2e::scenario::Fixture::Empty)
        .stub_cassette(stub()?)
        .env("BUTLER_E2E_RULE_CRASH_POINTS", "1");
    let mut s = start_setup(setup).await?;
    support::tool(&s, "general", "Reusable mandate", "record_user_feedback").await?;
    let state = s.sandbox.data.join("state");
    std::fs::write(
        state.join("rule-crash-arm.json"),
        json!({"stage":"receipt"}).to_string(),
    )?;
    let reached = state.join("rule-crash-reached.json");
    {
        let request = s.gw.post("/memory/feedback/consolidate", json!({}));
        tokio::pin!(request);
        tokio::select! {
            reply = &mut request => panic!("consolidation returned before crash: {reply:?}"),
            () = support::until(|| reached.exists()) => {},
        }
    }
    assert_eq!(support::active_rules(&s.sandbox.data).len(), 1);
    s.agent.kill9()?;
    s.restart().await?;
    support::until(|| {
        std::fs::read_to_string(s.sandbox.data.join("cognition/feedback/feedback.md"))
            .is_ok_and(|text| text.contains("resolution_reason: promoted"))
    })
    .await;
    let rule = support::active_rules(&s.sandbox.data).pop().unwrap();
    s.provider()?
        .add_placeholder("TARGET", rule["handle"].as_str().unwrap());
    support::tool(
        &s,
        "general",
        "Correct saved instruction",
        "record_user_feedback",
    )
    .await?;
    let reply = s.gw.post("/memory/feedback/consolidate", json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let after = support::active_rules(&s.sandbox.data);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0]["handle"], rule["handle"]);
    assert_ne!(after[0]["revision"], rule["revision"]);
    assert!(
        support::active_section(&s, "general", "Check applicable feedback")
            .await?
            .contains("verify today's sources, with dates")
    );
    s.finish().await
}
