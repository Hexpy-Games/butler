//! Recent feedback via production chat transport, with deterministic replay.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    dead_code,
    reason = "E2E assertions and shared helpers"
)]
#[path = "memory_rules/support.rs"]
mod support;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Fixture, Scenario, Setup},
};
use serde_json::{Value, json};

fn stub() -> Result<Cassette, HarnessError> {
    let mut cassette = Cassette::load("MEM-01")?;
    for (user, scope, text) in [
        (
            "Correct globally",
            "global",
            "Use the verified source, not stale results.",
        ),
        (
            "Correct project",
            "project",
            "PROJECT feedback applies here.",
        ),
        (
            "Correct session",
            "session",
            "SESSION feedback applies here.",
        ),
    ] {
        support::add_call(
            &mut cassette,
            user,
            "record_user_feedback",
            &json!({"text":text,"scope":scope,"category":"correction","target_ref":user,"retention_class":"working"}),
        );
    }
    for n in 0..14 {
        support::add_call(
            &mut cassette,
            &format!("Long correction {n}"),
            "record_user_feedback",
            &json!({"text":format!("{} End prohibition {n}: never use stale data.","Complete correction. ".repeat(40)),"scope":"global","category":"correction","target_ref":format!("source:{n}"),"retention_class":"ephemeral"}),
        );
    }
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = "Check applicable feedback".into();
    answer.request.key.round.clear();
    cassette.exchanges.push(answer);
    support::historical(&mut cassette);
    Ok(cassette)
}

async fn start(name: &str) -> Result<Scenario, HarnessError> {
    let setup = Setup::new(name)?
        .fixture(Fixture::Empty)
        .stub_cassette(stub()?);
    butler_e2e::e2e::fixtures::embedding_assets(&setup.sandbox.data)?;
    let s = setup.start().await?;
    s.provider()?.set_memory_responder(support::meaning);
    s.provider()?.set_chat_responder(behavior);
    s.patch_settings(json!({"access_mode":"ask_first","onboarding":{"consent_version":1,"accepted_at":"2026-10-02T00:00:00Z","completed_at":"2026-10-02T00:00:00Z"}}), "onboarding").await?;
    s.select_model(&s.model).await?;
    Ok(s)
}

fn behavior(request: &Value) -> Option<butler_e2e::e2e::cassette::ResponseRecord> {
    let input = request["input"].to_string();
    if !input.contains("Check applicable feedback") {
        return None;
    }
    let feedback = input
        .split("## Recent feedback")
        .skip(1)
        .collect::<Vec<_>>()
        .join(" ");
    let text = if feedback.contains("PROJECT feedback applies here.") {
        "PROJECT answer"
    } else {
        "GLOBAL answer"
    };
    Some(support::response(
        &json!({"type":"message","id":format!("msg_feedback{}",uuid::Uuid::new_v4().simple()),"role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}),
    ))
}

async fn prompt(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
    let before = s.provider()?.requests().len();
    let (_, turn) = s.turn(chat, "Check applicable feedback").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let messages = s.gw.messages(chat).await?;
    assert!(messages.iter().any(
        |m| m.to_string().contains("PROJECT answer") || m.to_string().contains("GLOBAL answer")
    ));
    Ok(s.provider()?.requests()[before..]
        .iter()
        .find(|r| r["reasoning"]["effort"] == "max")
        .unwrap()["input"]
        .to_string())
}

async fn project(s: &Scenario, name: &str) -> Result<(String, String), HarnessError> {
    let reply =
        s.gw.post("/projects", json!({"source":"scratch","display_name":name}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let id = reply.data()["project"]["id"].as_str().unwrap().to_owned();
    let chat = project_chat(s, &id, name).await?;
    Ok((id, chat))
}
async fn project_chat(s: &Scenario, project: &str, title: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","project_id":project,"title":title}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
}

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
