use super::*;
use butler_e2e::e2e::scenario::Scenario;
use serde_json::Value;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) fn data(reply: butler_e2e::e2e::gateway::Reply, status: u16) -> Value {
    assert_eq!(reply.status, status, "{}", reply.text);
    let mut body = reply.body;
    body["data"].take()
}
pub(super) async fn plan(
    s: &Scenario,
    script: &Arc<crate::canon_link::stub::Script>,
    first: &str,
) -> Result<(String, Vec<String>), HarnessError> {
    let epic = data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200);
    let project = epic["project_id"].as_str().unwrap();
    let plan = data(
        s.gw.post(
            &format!("/projects/{project}/canon/plans"),
            json!({"title":"Release"}),
        )
        .await?,
        201,
    );
    let id = plan["id"].as_str().unwrap().to_owned();
    let mut epics = script.epics.lock().unwrap().clone();
    let third = data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Release notes","plan_id":id}),
        )
        .await?,
        201,
    );
    for epic in &epics {
        let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
        data(
            s.gw.patch(
                &format!("/canon/epics/{epic}"),
                json!({"expected_revision":row["revision"],"plan_id":id}),
            )
            .await?,
            200,
        );
    }
    epics.push(third["id"].as_str().unwrap().to_owned());
    let plan = data(s.gw.get(&format!("/canon/plans/{id}")).await?, 200);
    data(
        s.gw.post(
            &format!("/canon/plans/{id}/order"),
            json!({"expected_revision":plan["revision"],"work_ids":epics}),
        )
        .await?,
        200,
    );
    *script.epics.lock().unwrap() = epics.clone();
    Ok((id, epics))
}
pub(super) async fn wait_done(
    s: &Scenario,
    chat: &str,
    count: usize,
) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let view = data(
            s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
            200,
        );
        let done = view["chains"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|c| c["steps"].as_array().unwrap())
            .flat_map(|s| s["items"].as_array().unwrap())
            .filter(|i| i["state"] == "done")
            .count();
        if done == count {
            return Ok(view);
        }
        assert!(Instant::now() < deadline, "{view}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub(super) async fn first_turn(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(turn) = s.gw.turns(chat).await?.first() {
            return Ok(turn["id"].as_str().unwrap().to_owned());
        }
        assert!(Instant::now() < deadline, "step turn was not admitted");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
