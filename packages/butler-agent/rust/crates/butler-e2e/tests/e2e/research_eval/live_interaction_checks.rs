use super::live_interactions::{Interactions, REPLY};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Access, Setup},
};
use serde_json::json;
use std::time::{Duration, Instant};

#[tokio::test]
async fn live_user_answers_three_forms_and_stops_on_fourth() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = crate::ask_user::stub::consecutive_cassette()?;
    let mut fourth = cassette.exchanges[2].clone();
    fourth.request.key.round = cassette.exchanges[3].request.key.round.clone();
    for chunk in &mut fourth.response.chunks {
        chunk.text = chunk
            .text
            .replace("fc_question_2", "fc_question_3")
            .replace("call_question_2", "call_question_3");
    }
    cassette.exchanges[3] = fourth;
    let s = Setup::new("RESEARCH-LIVE-ASK-CAP")?
        .stub_cassette(cassette)
        .start()
        .await?;
    s.provider()?
        .set_chat_responder(crate::briefing_effort::briefing);
    s.gw.say_turn("general", crate::ask_user::stub::PROMPT)
        .await?;
    let mut interactions = Interactions::default();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if !interactions.respond(&s.gw).await? {
            break;
        }
        assert!(Instant::now() < deadline, "fourth question never arrived");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(interactions.asks, 3);
    assert_eq!(interactions.approvals, 0);
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(
        view.data()["pending_questions"].as_array().unwrap().len(),
        1
    );
    let answers = view.data()["question_answers"].as_array().unwrap();
    assert_eq!(answers.len(), 3);
    for answer in answers {
        assert_eq!(answer["response"]["answers"][0]["custom"], REPLY);
    }
    s.finish().await
}

#[tokio::test]
async fn live_user_approves_child_exact_action_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = crate::steward_presentation::stub::start().await?;
    let setup = crate::steward_presentation::setup("RESEARCH-LIVE-CHILD-APPROVAL", &url)?
        .access(Access::AskAlways);
    std::fs::write(setup.sandbox.data.join("a.txt"), "Approach A")?;
    std::fs::write(setup.sandbox.data.join("b.txt"), "Approach B")?;
    *script.workspace.lock().unwrap() = setup.sandbox.data.to_string_lossy().into_owned();
    let s = setup.start().await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    s.turn("general", crate::steward_presentation::stub::OWNER)
        .await?;
    let mut interactions = Interactions::default();
    let deadline = Instant::now() + Duration::from_secs(30);
    while interactions.approvals == 0 {
        assert!(interactions.respond(&s.gw).await?);
        assert!(Instant::now() < deadline, "child approval never arrived");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(interactions.respond(&s.gw).await?);
    assert_eq!(interactions.approvals, 1);
    assert_eq!(interactions.asks, 0);
    let cards = s.gw.get("/authority-requests?session_id=general").await?;
    assert_eq!(
        cards.data()["permissions"],
        json!([]),
        "once must not grant durable permissions"
    );
    script.release.notify_one();
    server.abort();
    s.finish().await
}
