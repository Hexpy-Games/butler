//! Terminal Steward follow-ups continue through the real gateway in one Turn.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "delegate_followup/failure.rs"]
mod failure;
#[path = "delegate_followup/stub.rs"]
pub(crate) mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup, accepted_turn_id, turn_timeout},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[tokio::test]
async fn completed_delegation_followup_starts_with_prior_results() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(false).await
}
#[tokio::test]
async fn stopped_delegation_followup_starts_with_prior_context() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(true).await
}
async fn followup(stopped: bool) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start(stopped).await?;
    let s = Setup::new(if stopped {
        "FOLLOWUP-STOPPED"
    } else {
        "FOLLOWUP-COMPLETE"
    })?
    .stub_cassette(Cassette::load("TOOL-01")?)
    .env("BUTLER_CODEX_BASE_URL", &url)
    .env("BUTLER_APP_SERVER_PORT", "0")
    .start()
    .await?;
    s.turn("general", stub::OWNER).await?;
    let first = if stopped {
        tokio::time::timeout(Duration::from_secs(20), script.held.notified())
            .await
            .unwrap();
        let first = children(&s).await?.remove(0);
        let relation = first["relation"]["relation_id"].as_str().unwrap();
        let cancel =
            s.gw.post(
                &format!("/steward-relations/{relation}/cancel"),
                json!({"parent_session_id":"general"}),
            )
            .await?;
        assert_eq!(cancel.status, 202, "{cancel:?}");
        script.release.notify_one();
        wait_result(&s, relation, "cancelled").await?
    } else {
        wait_first(&s).await?
    };
    let relation = first["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    *script.relation.lock().unwrap() = relation.clone();
    let before = script.requests.lock().unwrap().len();
    let started = Instant::now();
    let turn = followup_turn(&s).await?;
    assert_eq!(turn["state"], "delivered", "{turn}\n{}", s.agent.logs());
    let second = wait_second(&s, &relation).await?;
    assert_ne!(second["session_id"], first["session_id"]);
    assert_eq!(second["result"]["status"], "success");
    assert_followup(&s, &script, before, &relation, stopped, &turn);
    assert_reply(&s, &turn).await?;
    eprintln!(
        "stopped={stopped}: new delegation and result in {} ms",
        started.elapsed().as_millis()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
async fn children(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    Ok(
        s.gw.get("/session-view?session_id=general").await?.data()["steward_children"]
            .as_array()
            .unwrap()
            .clone(),
    )
}
async fn followup_turn(s: &Scenario) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(turn_timeout());
    let accepted = s.gw.say("general", stub::FOLLOWUP).await?;
    let turn_id = match accepted_turn_id(&accepted) {
        Ok(id) => id,
        Err(_) => {
            assert_eq!(accepted["queued"]["text"], stub::FOLLOWUP, "{accepted}");
            assert!(accepted["queued"]["id"].as_str().is_some(), "{accepted}");
            loop {
                let messages = s.gw.messages("general").await?;
                let submitted: Vec<_> = messages
                    .iter()
                    .filter(|message| {
                        message["role"] == "user" && message["text"] == stub::FOLLOWUP
                    })
                    .collect();
                assert!(submitted.len() <= 1, "follow-up duplicated: {submitted:?}");
                if let Some(id) = submitted
                    .first()
                    .and_then(|message| message["turn_id"].as_str())
                {
                    break id.to_owned();
                }
                assert!(
                    Instant::now() < deadline,
                    "queued follow-up was not admitted: {accepted}\n{}",
                    s.agent.logs()
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    };
    s.gw.wait_terminal(
        "general",
        &turn_id,
        deadline.saturating_duration_since(Instant::now()),
    )
    .await
}
async fn wait_first(s: &Scenario) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(child) = children(s).await?.first()
            && let Some(relation) = child["relation"]["relation_id"].as_str()
        {
            return wait_result(s, relation, "success").await;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
async fn wait_result(s: &Scenario, relation: &str, status: &str) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let children = children(s).await?;
        let child = children
            .iter()
            .find(|c| c["relation"]["relation_id"] == relation)
            .unwrap();
        let messages = s.gw.messages("general").await?;
        if child["result"]["status"] == status
            && messages
                .iter()
                .any(|m| m["text"] == "원문 확인 결과를 정리했습니다.")
        {
            return Ok(child.clone());
        }
        assert!(
            Instant::now() < deadline,
            "{children:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
async fn wait_second(s: &Scenario, prior: &str) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let children = children(s).await?;
        if children.len() == 2 {
            let second = children
                .iter()
                .find(|c| c["relation"]["relation_id"] != prior)
                .unwrap();
            if second["result"]["status"] == "success" {
                return Ok(second.clone());
            }
        }
        assert!(
            Instant::now() < deadline,
            "{children:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
fn assert_followup(
    s: &Scenario,
    script: &stub::Script,
    before: usize,
    relation: &str,
    stopped: bool,
    turn: &Value,
) {
    let requests = script.requests.lock().unwrap();
    let followups: Vec<_> = requests[before..]
        .iter()
        .filter(|body| {
            butler_e2e::e2e::matching::key("/codex/responses", body, &Default::default())
                .user_request
                == stub::FOLLOWUP
        })
        .collect();
    assert_eq!(followups.len(), 5, "{followups:?}");
    assert!(
        followups[0]
            .to_string()
            .contains("closed: new requests need a fresh reviewed Work")
    );
    assert!(followups[0].to_string().contains("previous_relation_id"));
    let feedback = followups[1]["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["output"].as_str())
        .filter_map(|o| serde_json::from_str::<Value>(o).ok())
        .find(|o| o.pointer("/output/error/code") == Some(&json!("delegated_session_closed")))
        .unwrap();
    assert_eq!(
        feedback["output"]["next_action"]["previous_relation_id"],
        relation
    );
    assert_eq!(
        feedback["output"]["prior_context"]["result"]["status"],
        if stopped { "cancelled" } else { "success" }
    );
    let child = requests[before..]
        .iter()
        .find(|body| {
            butler_e2e::e2e::matching::key("/codex/responses", body, &Default::default())
                .user_request
                .starts_with("role: steward request: 다시 조사해줄래?")
        })
        .unwrap()
        .to_string();
    assert!(child.contains(stub::OWNER));
    assert!(child.contains(relation));
    if !stopped {
        assert!(child.contains("Original evidence: paper A verified."));
    }
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let count: i64 = db.query_row("SELECT count(*) FROM btcc_subsession_delegations d JOIN btcc_session_relations r USING(relation_id) WHERE r.parent_turn_id=?1", [turn["id"].as_str().unwrap()], |row| row.get(0)).unwrap();
    assert_eq!(
        count, 1,
        "fresh delegation must start in the follow-up Turn"
    );
    let packet: String = db.query_row("SELECT packet_json FROM btcc_subsession_delegations d JOIN btcc_session_relations r USING(relation_id) WHERE r.parent_turn_id=?1", [turn["id"].as_str().unwrap()], |row| row.get(0)).unwrap();
    let packet: Value = serde_json::from_str(&packet).unwrap();
    assert!(packet["prior_context"].as_str().unwrap().contains(relation));
    assert_eq!(
        packet["objective"],
        "다시 조사해줄래? 추가 원문도 확인해 주세요."
    );
    let roots: Vec<(String, String)> = {
        let mut q = db.prepare("SELECT d.root_work_id,w.status FROM btcc_subsession_delegations d JOIN btcc_guided_works w ON w.work_id=d.root_work_id ORDER BY d.created_at").unwrap();
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(roots.len(), 2);
    assert_ne!(roots[0].0, roots[1].0);
    assert_eq!(roots[0].1, if stopped { "abandoned" } else { "completed" });
    assert_eq!(roots[1].1, "completed");
}
async fn assert_reply(s: &Scenario, turn: &Value) -> Result<(), HarnessError> {
    let messages = s.gw.messages("general").await?;
    let reply = messages
        .iter()
        .filter(|m| m["turn_id"] == turn["id"] && m["role"] == "assistant")
        .filter_map(|m| m["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(reply.contains("다시 조사하겠습니다"), "{reply}");
    for forbidden in ["새로 시작해", "연결이 종료", "미안", "restart"] {
        assert!(!reply.contains(forbidden), "{reply}");
    }
    Ok(())
}
