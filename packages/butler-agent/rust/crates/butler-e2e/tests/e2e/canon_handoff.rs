//! Canon changes stay with Butler: one multi-change canon_propose lands every
//! epic, a Steward has no canon tools, and its proposed changes reach Butler's
//! result turn where canon_propose is offered. Project chats carry the canon
//! note for the turn's role; other chats carry none.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    chatgpt_wire::functions,
    gateway::{Reply, turn_state},
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const CREATE: &str = "이 프로젝트에서 앞으로 진행할 과제 세 개를 등록해 줘";
const RESEARCH: &str = "비슷한 제품을 조사해서 필요한 과제를 더 정리해 줘";
const HELLO: &str = "오늘 일정 알려줘";
const CREATED: [&str; 3] = ["가입 흐름 정리", "알림 설정 추가", "검색 속도 개선"];
const PROPOSED: [&str; 2] = ["오프라인 모드", "데이터 내보내기"];
const APPLIED: &str = "조사 결과의 과제 두 개를 등록했습니다.";
const NOTE: &str = "## Canon in this project";

fn data(reply: Reply, status: u16) -> Value {
    assert_eq!(reply.status, status, "{}", reply.text);
    let mut body = reply.body;
    body["data"].take()
}

/// A project chat whose project has no epic bound to it yet.
async fn project_chat(s: &Scenario) -> Result<(String, String), HarnessError> {
    let created = s.gw.post(
        "/projects",
        json!({"source":"scratch","display_name":"제품"}),
    );
    let project = data(created.await?, 201)["project"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = s.gw.post(
        "/sessions",
        json!({"kind":"project","title":"과제 정리","project_id":project}),
    );
    let chat = data(session.await?, 201)["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Ok((project, chat))
}

fn offers(request: &Value, name: &str) -> bool {
    functions(request).any(|tool| tool["name"] == name)
}

fn has_note(request: &Value) -> bool {
    request["input"].to_string().contains(NOTE)
}

fn epic_creates(arguments: &Value) -> Vec<String> {
    arguments["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|change| change["op"] == "epic.create")
        .map(|change| change["title"].as_str().unwrap().to_owned())
        .collect()
}

/// Every model tool call of the scenario: (turn, tool, arguments).
fn calls(s: &Scenario) -> Result<Vec<(String, String, Value)>, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let mut statement = db.prepare(
        "SELECT turn_id,tool_name,arguments_json FROM btcc_guided_tool_calls ORDER BY rowid",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut found = Vec::new();
    for row in rows {
        let (turn, name, arguments) = row?;
        found.push((
            turn,
            name,
            serde_json::from_str(&arguments).unwrap_or(Value::Null),
        ));
    }
    Ok(found)
}

async fn backlog(s: &Scenario, project: &str) -> Result<Vec<String>, HarnessError> {
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    let mut titles: Vec<String> = board["backlog"]
        .as_array()
        .unwrap()
        .iter()
        .map(|card| card["title"].as_str().unwrap().to_owned())
        .collect();
    titles.sort();
    Ok(titles)
}

async fn wait_applied(s: &Scenario, chat: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        let messages = s.gw.messages(chat).await?;
        if messages.iter().any(|message| message["text"] == APPLIED) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("Butler applied the Steward's proposed changes");
}

fn sorted(titles: &[&str]) -> Vec<String> {
    let mut titles: Vec<String> = titles.iter().map(|title| (*title).to_owned()).collect();
    titles.sort();
    titles
}

#[tokio::test]
async fn butler_applies_canon_changes_and_the_steward_hands_them_back() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("CANON-HANDOFF")?
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    let (project, chat) = project_chat(&s).await?;
    *script.project.lock().unwrap() = project.clone();

    let (turn_id, turn) = s.turn(&chat, CREATE).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = script.requests.lock().unwrap().clone();
    let first = requests
        .iter()
        .find(|request| stub::asks(request, CREATE))
        .expect("Butler's first round for the request");
    assert!(has_note(first), "a project chat carries the canon note");
    let proposals: Vec<_> = calls(&s)?
        .into_iter()
        .filter(|(turn, name, _)| *turn == turn_id && name == "canon_propose")
        .collect();
    assert_eq!(proposals.len(), 1, "{proposals:?}");
    assert_eq!(epic_creates(&proposals[0].2), CREATED);
    assert_eq!(backlog(&s, &project).await?, sorted(&CREATED));

    let (_, turn) = s.turn(&chat, RESEARCH).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    wait_applied(&s, &chat).await?;
    let requests = script.requests.lock().unwrap().clone();
    let steward: Vec<_> = requests.iter().filter(|r| stub::steward(r)).collect();
    assert!(!steward.is_empty(), "the research ran in a Steward");
    for request in &steward {
        let names: Vec<_> = functions(request)
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(
            !names.iter().any(|name| name.starts_with("canon_")),
            "{names:?}"
        );
        assert!(has_note(request), "the Steward gets its own canon note");
    }
    let returning = requests
        .iter()
        .find(|request| stub::returning(request))
        .expect("Butler received the Steward's result");
    assert!(
        returning["input"].to_string().contains(stub::REPORT),
        "the Steward's proposed changes reach Butler"
    );
    assert!(offers(returning, "canon_propose"));
    let applied: Vec<_> = calls(&s)?
        .into_iter()
        .filter(|(_, name, _)| name == "canon_propose")
        .collect();
    assert_eq!(applied.len(), 2, "{applied:?}");
    assert_eq!(epic_creates(&applied[1].2), PROPOSED);
    let mut all = CREATED.to_vec();
    all.extend(PROPOSED);
    assert_eq!(backlog(&s, &project).await?, sorted(&all));

    let other = data(
        s.gw.post("/sessions", json!({"title":"일상","kind":"chat"}))
            .await?,
        201,
    )["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (_, turn) = s.turn(&other, HELLO).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = script.requests.lock().unwrap().clone();
    let plain = requests
        .iter()
        .find(|request| stub::asks(request, HELLO))
        .expect("Butler's round in the non-project chat");
    assert!(
        !has_note(plain),
        "a chat without a project has no canon note"
    );
    server.abort();
    s.finish().await
}
