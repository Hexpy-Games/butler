#[path = "../memory_rules/support.rs"]
pub(super) mod support;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Fixture, Scenario, Setup},
};
use serde_json::{Value, json};

pub(super) fn stub() -> Result<Cassette, HarnessError> {
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
    for (user, text, category, retention) in [
        (
            "Reusable mandate",
            "Reusable mandate: always verify current sources.",
            "correction",
            "working",
        ),
        (
            "Transient feedback",
            "Transient correction for this answer only.",
            "correction",
            "ephemeral",
        ),
        (
            "Pinned complaint",
            "Pinned quality complaint: that result was poor.",
            "quality_signal",
            "pinned",
        ),
        (
            "Stable preference",
            "Stable preference: I prefer concise answers.",
            "correction",
            "working",
        ),
        (
            "Session only",
            "Session-only correction.",
            "session_only",
            "session_only",
        ),
        (
            "Ephemeral feedback",
            "Seven-day correction.",
            "correction",
            "ephemeral",
        ),
    ] {
        support::add_call(
            &mut cassette,
            user,
            "record_user_feedback",
            &json!({"text":text,"scope":"global","category":category,"target_ref":user,"retention_class":retention}),
        );
    }
    support::add_call(
        &mut cassette,
        "Project mandate",
        "record_user_feedback",
        &json!({"text":"Reusable mandate: always verify this project's sources.","scope":"project","category":"correction","target_ref":"source:project","retention_class":"working"}),
    );
    support::add_call(
        &mut cassette,
        "Correct saved instruction",
        "record_user_feedback",
        &json!({"text":"Reusable mandate: verify today's sources, with dates.","scope":"global","category":"correction","target_ref":"{{TARGET}}","retention_class":"working"}),
    );
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

pub(super) async fn start(name: &str) -> Result<Scenario, HarnessError> {
    let setup = Setup::new(name)?
        .fixture(Fixture::Empty)
        .stub_cassette(stub()?);
    start_setup(setup).await
}

pub(super) async fn start_setup(setup: Setup) -> Result<Scenario, HarnessError> {
    butler_e2e::e2e::fixtures::embedding_assets(&setup.sandbox.data)?;
    let s = setup.start().await?;
    s.provider()?.set_memory_responder(support::meaning);
    s.provider()?.set_chat_responder(behavior);
    s.patch_settings(json!({"access_mode":"ask_first","onboarding":{"consent_version":1,"accepted_at":"2026-10-02T00:00:00Z","completed_at":"2026-10-02T00:00:00Z"}}), "onboarding").await?;
    s.select_model(&s.model).await?;
    Ok(s)
}

pub(super) fn behavior(request: &Value) -> Option<butler_e2e::e2e::cassette::ResponseRecord> {
    let raw = request["input"]
        .as_str()
        .or_else(|| request["input"][0]["content"][0]["text"].as_str())
        .unwrap_or("");
    if let Ok(input) = serde_json::from_str::<Value>(raw) {
        let output = match input["task"].as_str() {
            Some("extract_profile_candidates") => Some(json!({"candidates":[]})),
            Some("general_new_chat_briefing" | "project_new_chat_briefing") => Some(json!({
                "moment":"Today", "title":"Welcome", "description":"Topics to discuss",
                "suggestions": (0..4).map(|n| json!({"id":format!("topic-{n}"),"title":format!("Topic {n}"),"description":"Explore", "text":"Discuss this topic", "source_kind":"current_interest"})).collect::<Vec<_>>(),
                "title_variants":{"morning":"Welcome","afternoon":"Welcome","evening":"Welcome","night":"Welcome"}
            })),
            _ => None,
        };
        if let Some(output) = output {
            return Some(support::response(
                &json!({"type":"message","id":format!("msg_cycle{}",uuid::Uuid::new_v4().simple()),"role":"assistant","status":"completed","content":[{"type":"output_text","text":output.to_string(),"annotations":[]}]}),
            ));
        }
    }
    if let Ok(review) = serde_json::from_str::<Value>(raw)
        && review.get("feedback_review").is_some()
    {
        let text = review["feedback_review"]["text"].as_str().unwrap();
        let disposition = if text.starts_with("Reusable mandate") {
            "instructions"
        } else if text.starts_with("Stable preference") {
            "profile"
        } else if text.starts_with("Transient") {
            "discard"
        } else {
            "defer"
        };
        return Some(support::response(
            &json!({"type":"message","id":format!("msg_review{}",uuid::Uuid::new_v4().simple()),"role":"assistant","status":"completed","content":[{"type":"output_text","text":json!({"disposition":disposition,"profile_category":"communication"}).to_string(),"annotations":[]}]}),
        ));
    }
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

pub(super) async fn prompt(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
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

pub(super) async fn project(s: &Scenario, name: &str) -> Result<(String, String), HarnessError> {
    let reply =
        s.gw.post("/projects", json!({"source":"scratch","display_name":name}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let id = reply.data()["project"]["id"].as_str().unwrap().to_owned();
    let chat = project_chat(s, &id, name).await?;
    Ok((id, chat))
}
pub(super) async fn project_chat(
    s: &Scenario,
    project: &str,
    title: &str,
) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","project_id":project,"title":title}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
}
