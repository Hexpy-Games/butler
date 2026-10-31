//! CP user flows through the real Butler tool executor, canon lane and App API.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod attachments;
mod cleanup;
mod epic_delete;
mod migration;
mod operations;
mod queries;
mod recovery;
mod review;
pub(super) mod stub;
mod variants;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    events::LiveEvents,
    gateway::{Reply, turn_state},
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
fn data(reply: Reply, status: u16) -> Value {
    assert_eq!(reply.status, status, "{}", reply.text);
    let mut body = reply.body;
    body["data"].take()
}
async fn setup(
    name: &str,
    access: Access,
) -> Result<
    (
        Scenario,
        Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
        String,
        String,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start().await?;
    let s = Setup::new(name)?
        .access(access)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    let p = data(
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"제품"}),
        )
        .await?,
        201,
    );
    let project = p["project"]["id"].as_str().unwrap().to_owned();
    let chat = data(
        s.gw.post("/sessions", json!({"title":"등록 대화","kind":"chat"}))
            .await?,
        201,
    )["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Ok((s, script, server, project, chat))
}
fn proposal(project: &str, title: &str) -> Value {
    json!({"project_id":project,"summary":title,"changes":[{"op":"epic.create","title":title,"description":"재현 단계와 기대 동작","tags":[{"new":{"name":"버그","color":"red"}}]}]})
}
async fn run(
    s: &Scenario,
    script: &stub::Script,
    chat: &str,
    message: &str,
    calls: Vec<(&str, Value)>,
) -> Result<(), HarnessError> {
    stub::arm(script, message, calls);
    let (_, turn) = s.turn(chat, message).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    Ok(())
}
async fn asks(s: &Scenario, chat: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.get(&format!("/sessions/{chat}/pending-asks")).await?,
        200,
    ))
}
async fn draft(
    s: &Scenario,
    script: &stub::Script,
    chat: &str,
    args: Value,
) -> Result<String, HarnessError> {
    run(
        s,
        script,
        chat,
        "이 문제를 버그로 등록해 줘",
        vec![("canon_propose", args)],
    )
    .await?;
    let page = asks(s, chat).await?;
    assert_eq!(page["open_count"], 1, "{page}");
    let ask = &page["asks"][0];
    assert_eq!(ask["kind"], "canon_proposal");
    assert_eq!(ask["actions"], json!(["accept", "decline", "dismiss"]));
    assert!(ask["source_message_id"].is_string());
    assert!(ask["source_call_id"].is_string());
    assert_eq!(ask["blocking"], false);
    Ok(ask["ask_id"]
        .as_str()
        .unwrap()
        .trim_start_matches("canon:")
        .into())
}
async fn read(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.get(&format!("/canon/proposals/{id}")).await?,
        200,
    ))
}
async fn accept(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.post(
            &format!("/canon/proposals/{id}"),
            json!({"outcome":"accepted"}),
        )
        .await?,
        200,
    ))
}
fn epic_id(result: &Value) -> String {
    result["bound"][0]
        .as_str()
        .unwrap()
        .trim_start_matches("canon:epic/")
        .into()
}
async fn assert_bound(
    s: &Scenario,
    chat: &str,
    project: &str,
    id: &str,
    origin: &str,
) -> Result<(), HarnessError> {
    let epic = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
    assert_eq!(epic["origin"], "chat");
    assert_eq!(epic["home_session_id"], Value::Null);
    assert_eq!(epic["session_ids"], json!([chat]));
    assert_eq!(epic["sessions"][0]["origin"], origin);
    let session = data(
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?,
        200,
    );
    assert_eq!(
        session["project_id"],
        Value::Null,
        "binding never moves the chat"
    );
    let sidebar = data(
        s.gw.get(&format!("/projects/{project}/canon/sidebar"))
            .await?,
        200,
    );
    assert_eq!(sidebar["groups"][0]["rows"][0]["id"], id);
    Ok(())
}
#[tokio::test]
async fn cp_01_card_applies_chat_origin_binds_without_moving_and_links_work()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-01", Access::AskAlways).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let id = draft(&s, &script, &chat, proposal(&project, "입력 오류")).await?;
    let card = read(&s, &id).await?;
    assert_eq!(card["state"], "open");
    assert_eq!(s.gw.approval_requests(&chat).await?, Vec::<Value>::new());
    assert_eq!(card["epics"][0]["tags"][0]["new"], true);
    let result = accept(&s, &id).await?;
    assert_eq!(result["ok"], true, "{result}");
    let epic = epic_id(&result);
    assert_bound(&s, &chat, &project, &epic, "user").await?;
    live.wait_for(Duration::from_secs(10), |e| {
        e["type"] == "pending_asks.changed"
            && e["payload"]["proposal_id"] == id
            && e["payload"]["state"] == "applied"
    })
    .await?;
    assert_eq!(asks(&s, &chat).await?["open_count"], 0);
    run(&s,&script,&chat,"이 과제의 내용을 확인하고 보고해",vec![
        ("replace_work_plan",json!({"objective":"과제 확인","execution_mode":"direct","governing_refs":[format!("canon:epic/{epic}")],"actions":[{"action_key":"inspect","description":"과제 내용 확인"}],"checks":["등록 내용 일치"]})),
        ("record_work_review",json!({"subject":"plan","verdict":"accept","summary":"확인 범위 충족"})),
        ("canon_read",json!({"view":"epic","id":epic})),
        ("record_work_checkpoint",json!({"action_updates":[{"action_key":"inspect","status":"done"}],"public_summary":"등록 내용 확인","next_step":"결과 검토"})),
        ("record_work_review",json!({"subject":"result","verdict":"accept","summary":"등록 내용 일치"})),
        ("record_work_review",json!({"subject":"completion","verdict":"accept","summary":"검증 완료"})),
        ("record_work_disposition",json!({"work_id":"$work","disposition":"completed","summary":"등록 내용 확인 완료","action_updates":[],"remaining_actions":[],"followups":[]})),
    ]).await?;
    let results = stub::results(&script);
    assert!(
        !results
            .iter()
            .any(|r| r["error"]["code"] == "canon_epic_not_bound")
    );
    let progress = data(
        s.gw.get(&format!("/canon/epics/{epic}/progress")).await?,
        200,
    );
    assert_eq!(progress["counts"]["total"], 1, "{progress}");
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn cp_02_chat_acceptance_checks_quote_and_uses_same_apply() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-02", Access::AskAlways).await?;
    let id = draft(&s, &script, &chat, proposal(&project, "단축키 오류")).await?;
    run(
        &s,
        &script,
        &chat,
        "아직",
        vec![(
            "resolve_ask",
            json!({"ask_id":format!("canon:{id}"),"outcome":"accepted","quote":"응 등록해"}),
        )],
    )
    .await?;
    assert_eq!(read(&s, &id).await?["state"], "open");
    assert!(
        stub::results(&script)
            .iter()
            .any(|r| r["error"]["code"] == "quote_not_found")
    );
    run(
        &s,
        &script,
        &chat,
        "응 등록해",
        vec![(
            "resolve_ask",
            json!({"ask_id":format!("canon:{id}"),"outcome":"accepted","quote":"응 등록해"}),
        )],
    )
    .await?;
    let card = read(&s, &id).await?;
    assert_eq!(card["state"], "applied");
    assert_eq!(card["resolved_by"], "chat");
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn cp_03_new_call_supersedes_then_card_applies_backlog() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("CP-03", Access::AskExceptReads).await?;
    let plan = data(
        s.gw.post(
            &format!("/projects/{project}/canon/plans"),
            json!({"title":"프리뷰 14"}),
        )
        .await?,
        201,
    );
    let mut args = proposal(&project, "검색 오류");
    args["changes"][0]["plan_id"] = plan["id"].clone();
    let old = draft(&s, &script, &chat, args).await?;
    run(
        &s,
        &script,
        &chat,
        "프리뷰 14 말고 백로그로",
        vec![("canon_propose", proposal(&project, "검색 오류"))],
    )
    .await?;
    assert_eq!(read(&s, &old).await?["state"], "superseded");
    let page = asks(&s, &chat).await?;
    let id = page["asks"][0]["ask_id"]
        .as_str()
        .unwrap()
        .trim_start_matches("canon:");
    let result = accept(&s, id).await?;
    assert_eq!(result["applied"][0]["plan"], "Backlog");
    server.abort();
    s.finish().await
}
