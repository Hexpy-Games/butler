use super::{boundaries::held, work_model::*};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::{Duration, Instant};

pub(super) async fn run() -> Result<(), HarnessError> {
    let label = "Resume the durably injected instruction";
    let mut cassette = Cassette::load("TURN-02")?;
    let mut first = cassette.exchanges[0].clone();
    first.request.key.user_request = label.into();
    for chunk in &mut first.response.chunks {
        chunk.delay_ms = 0;
    }
    first.response.chunks[0].delay_ms = 1000;
    let mut resumed = first.clone();
    resumed.request.key.round = vec!["user".into()];
    for chunk in &mut resumed.response.chunks {
        chunk.delay_ms = 0;
    }
    cassette.exchanges.extend([first, resumed]);
    let mut s = Setup::new("WM-10-INJECTION")?
        .env("BUTLER_WORK_MODEL", "core")
        .env("BUTLER_E2E_INSTRUCTION_BOUNDARY", "injection")
        .env("BUTLER_E2E_INSTRUCTION_MESSAGE", label)
        .stub_cassette(cassette)
        .start()
        .await?;
    s.provider()?.set_pacing(butler_e2e::e2e::provider::Pacing {
        scale: 1.0,
        cap_ms: 1000,
        min_ms: 0,
    });
    let accepted = s.gw.say("general", label).await?;
    let turn = accepted_turn_id(&accepted)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while s.provider()?.served() == 0 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let steer = s.gw.post("/messages",json!({"chat_id":"general","client_message_id":"restart-steer","text":"Retain this instruction through restart","mode":"steer"})).await?;
    assert_eq!(steer.status, 202, "{}", steer.text);
    for index in 0..3 {
        assert_eq!(s.gw.post("/messages",json!({"chat_id":"general","client_message_id":format!("restart-queue-{index}"),"text":"Reply with exactly the word: once","mode":"queue"})).await?.status,202);
    }
    held(&s).await?;
    let before =
        s.gw.get("/sessions/general/instructions")
            .await?
            .data()
            .clone();
    assert_eq!(before["instructions"][1]["status"], "delivered");
    assert_eq!(before["instructions"].as_array().unwrap().len(), 5);
    s.crash_and_restart().await?;
    let after =
        s.gw.get("/sessions/general/instructions")
            .await?
            .data()
            .clone();
    assert_eq!(
        after["instructions"][1], before["instructions"][1],
        "Restart changed an unacknowledged receipt"
    );
    for (old, new) in before["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .zip(after["instructions"].as_array().unwrap())
    {
        assert_eq!(old["instruction_id"], new["instruction_id"]);
        assert_eq!(old["anchor"], new["anchor"]);
        assert_eq!(old["mode"], new["mode"]);
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let receipts = s.gw.get("/sessions/general/instructions").await?;
        if receipts.data()["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .skip(2)
            .all(|r| r["status"] == "applied")
        {
            let queue = s.gw.get("/session-queue?chat_id=general").await?;
            if queue.data()["queued_messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["state"] == "failed")
            {
                let turns = s.gw.turns("general").await?;
                if turns.len() == 4
                    && turns
                        .iter()
                        .all(|t| matches!(t["state"].as_str(), Some("delivered" | "failed")))
                {
                    break;
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "Restart did not drain the entire queue: {}",
            receipts.text
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let retry =
        s.gw.post(&format!("/turns/{turn}/retry"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    assert_eq!(
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?["state"],
        "delivered",
        "provider misses: {:?}",
        s.provider()?.misses()
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let receipts = s.gw.get("/sessions/general/instructions").await?;
        if receipts.data()["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["status"] == "applied")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Follow-up queue stranded: {}",
            receipts.text
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(s.gw.turns("general").await?.len(), 4);
    assert_eq!(summary(&s).await?["total"], 0);
    assert_eq!(s.provider()?.served(), 5);
    assert!(
        s.provider()?
            .requests()
            .last()
            .unwrap()
            .to_string()
            .contains("Retain this instruction through restart")
    );
    s.finish().await
}
