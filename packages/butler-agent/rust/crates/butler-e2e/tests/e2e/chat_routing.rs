//! Sidebar chats delegate all work; projects and schedule runs keep direct Work.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "support/chat_routing_stub.rs"]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::tool_rows,
    matching,
    sanitize::Placeholders,
    scenario::{Setup, turn_timeout},
};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn chat_routes_work_to_steward_while_projects_and_schedules_keep_direct_work()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("CHAT-ROUTING")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    let (turn, done) = s.turn("general", stub::KNOWLEDGE).await?;
    assert_eq!(done["state"], "delivered", "{done}");
    let rows = tool_rows(&s.gw.messages("general").await?, &turn);
    assert_eq!(rows, Vec::<serde_json::Value>::new());
    let (_, done) = s.turn("general", stub::LOOKUP).await?;
    assert_eq!(done["state"], "delivered", "{done}");
    let deadline = std::time::Instant::now() + Duration::from_secs(turn_timeout());
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        if view.data()["steward_children"][0]["result"]["status"] == "success" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "{view:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Routing"}),
        )
        .await?;
    assert_eq!(project.status, 201, "{project:?}");
    let session = s
        .gw
        .post(
            "/sessions",
            json!({"kind":"project","title":"Routing","project_id":project.data()["project"]["id"]}),
        )
        .await?;
    assert_eq!(session.status, 201, "{session:?}");
    let session = session.data()["session"]["id"].as_str().unwrap();
    let (_, done) = s.turn(session, stub::PROJECT).await?;
    assert_eq!(done["state"], "delivered", "{done}");
    let schedule =
        s.gw.post(
            "/automations",
            json!({"title":"Greeting","prompt_body":stub::SCHEDULED,
                "target_session_id":"general","interval_seconds":3600}),
        )
        .await?;
    assert_eq!(schedule.status, 201, "{}", schedule.text);
    let id = schedule.data()["automation"]["id"].as_str().unwrap();
    let run =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert_eq!(run.status, 202, "{}", run.text);
    let turn_id = run.data()["run"]["turn_id"].as_str().unwrap();
    let done =
        s.gw.wait_terminal("general", turn_id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(done["state"], "delivered", "{done}");
    for text in [stub::KNOWLEDGE, stub::LOOKUP] {
        let request = first_request(&script, text);
        assert!(request.contains(stub::CHAT_ROUTE), "{request}");
        assert!(!request.contains(stub::DEFAULT_ROUTE), "{request}");
    }
    for text in [stub::PROJECT, stub::SCHEDULED] {
        let request = first_request(&script, text);
        assert!(request.contains(stub::DEFAULT_ROUTE), "{request}");
        assert!(!request.contains(stub::CHAT_ROUTE), "{request}");
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
fn first_request(script: &stub::Script, text: &str) -> String {
    script
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|body| {
            let request =
                matching::key("/v1/responses", body, &Placeholders::default()).user_request;
            request.contains(text) && !request.starts_with("role: steward")
        })
        .map(ToString::to_string)
        .unwrap()
}
