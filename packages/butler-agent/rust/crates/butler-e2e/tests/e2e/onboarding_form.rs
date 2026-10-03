//! First-chat onboarding uses the durable question form and persists its answers.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "support/onboarding_form.rs"]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Fixture, Setup, accepted_turn_id},
};
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn onboarding_form_replays_questions_and_persists_profile() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("ONBOARDING-FORM")?
        .fixture(Fixture::FirstConversation)
        .access(Access::AskFirst)
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"language":"ko"}))
            .await?
            .status,
        200
    );
    assert_eq!(
        s.gw.patch("/personalization", json!({"response_language":"ko"}))
            .await?
            .status,
        200
    );
    let turn = accepted_turn_id(&s.gw.say("general", stub::PROMPT).await?)?;
    for (id, answer) in [("principal_name", "민수"), ("preferred_address", "민수님")] {
        let parked =
            s.gw.wait_turn(
                "general",
                &turn,
                &["waiting_for_form", "failed", "delivered"],
                Duration::from_secs(20),
            )
            .await?;
        assert_eq!(turn_state(&parked), "waiting_for_form", "{parked}");
        let view = s.gw.get("/session-view?session_id=general").await?;
        let q = &view.data()["pending_questions"][0];
        assert_eq!(q["questions"], stub::questions(id));
        let requests = s.provider()?.requests();
        let request = requests.last().unwrap();
        assert!(
            request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == "ask_user"),
            "ask_user hidden: {}",
            request["tools"]
        );
        let prompt = request["instructions"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
            + &request["input"].to_string();
        assert!(
            prompt.contains("각 온보딩 질문은 반드시 `ask_user`"),
            "onboarding does not require question forms"
        );
        let reply = s.gw.post(&format!("/authority-requests/{}/answer?session_id=general",q["request_ref"].as_str().unwrap()),
            json!({"status":"answered","answers":[{"id":id,"selected":[],"custom":answer,"skipped":false}]})).await?;
        assert_eq!(reply.status, 202, "{}", reply.text);
        if id == "principal_name" {
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            loop {
                let view = s.gw.get("/session-view?session_id=general").await?;
                if view.data()["pending_questions"][0]["questions"]["questions"][0]["id"]
                    == "preferred_address"
                {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "second question absent: {}",
                    view.text
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    let profile: Value = serde_json::from_slice(&std::fs::read(
        s.sandbox.data.join("personalization/profile.json"),
    )?)?;
    assert_eq!(profile["principal_name"], "민수");
    assert_eq!(profile["preferred_address"], "민수님");
    let briefing = s.gw.get("/new-chat-briefing").await?;
    assert!(
        briefing.data()["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["id"] != "butler-onboarding")
    );
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["pending_questions"], json!([]));
    assert_eq!(view.data()["question_answers"].as_array().unwrap().len(), 2);
    assert_eq!(s.provider()?.requests().len(), 5);
    s.finish().await
}

/// Installer consent is distinct from profile onboarding; generated cards never hide pending onboarding.
#[tokio::test]
async fn onboarding_entry_precedes_generated_cards_until_profile_completion()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("ONBOARDING-ENTRY")?.fixture(Fixture::FirstConversation);
    let path = setup
        .sandbox
        .data
        .join("cognition/consolidation/briefings/2026-09-27/general.json");
    std::fs::create_dir_all(path.parent().unwrap())?;
    let cards: Vec<_> = (0..5).map(|n| json!({"id":format!("card-{n}"), "title":format!("Card {n}"), "description":"Description", "text":format!("Prompt {n}"), "source_kind":"current_interest"})).collect();
    std::fs::write(&path, json!({
        "schema":"butler.cognition.new-chat-briefing.v1", "briefing_id":"ncb_entry", "scope":"general", "locale":"ko",
        "title":"오늘의 시작", "description":"오늘 살펴볼 항목입니다.", "suggestions":cards,
        "source":{"consolidation_run_id":"cr_entry", "generated_at":"2026-09-27T00:00:00Z", "persona_applied":false, "model_ref":"local/stub", "reasoning_effort":"low", "raw_text_included":false}, "raw_text_included":false
    }).to_string())?;
    let mut s = setup.start().await?;
    let reply=s.gw.patch("/settings",json!({"language":"ko","onboarding":{"consent_version":2,"accepted_at":"2026-09-27T00:00:00Z","completed_at":"2026-09-27T00:00:01Z"}})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    for locale in ["ko", "en"] {
        assert_eq!(
            s.gw.patch("/settings", json!({"language":locale}))
                .await?
                .status,
            200
        );
        let briefing = s.gw.get("/new-chat-briefing?date=2026-09-27").await?;
        assert_eq!(briefing.data()["suggestions"].as_array().unwrap().len(), 1);
        assert_eq!(briefing.data()["suggestions"][0]["id"], "butler-onboarding");
        assert_eq!(
            briefing.data()["suggestions"][0]["title"],
            if locale == "ko" {
                "버틀러와 알아가기"
            } else {
                "Get acquainted with Butler"
            }
        );
    }
    s.restart().await?;
    let pending = s.gw.get("/new-chat-briefing?date=2026-09-27").await?;
    assert_eq!(pending.data()["source"]["scope"], "onboarding");
    butler_e2e::e2e::fixtures::onboarding_complete(&s.sandbox.data)?;
    assert_eq!(
        s.gw.patch("/settings", json!({"language":"ko"}))
            .await?
            .status,
        200
    );
    let generated = s.gw.get("/new-chat-briefing?date=2026-09-27").await?;
    assert_eq!(generated.data()["source"]["content_origin"], "generated");
    let expected:Vec<_>=cards.iter().map(|c|json!({"id":c["id"],"title":c["title"],"description":c["description"],"text":c["text"]})).collect();
    assert_eq!(generated.data()["suggestions"], json!(expected));
    let fallback = s.gw.get("/new-chat-briefing?date=2026-09-26").await?;
    assert_eq!(
        fallback.data()["source"]["content_origin"],
        "heuristic_fallback"
    );
    assert_eq!(fallback.data()["suggestions"].as_array().unwrap().len(), 4);
    s.finish().await
}
