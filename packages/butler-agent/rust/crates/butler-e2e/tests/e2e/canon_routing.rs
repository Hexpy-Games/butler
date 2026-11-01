//! Canon writes stay with Butler in a project chat: what the model is shown,
//! and what the runtime does with the calls it makes.
//!
//! The stub provider cannot choose a route, so this file never trusts its own
//! script for that. It checks what a real model would read when it routes a
//! canon request (the routing rule inside Butler's do-it-yourself list, the
//! project's canon note, the delegate and Ledger tool contracts, the Steward's
//! tools and hand-back rule) and what the runtime makes of the calls that
//! rule asks for: one multi-epic canon_propose lands every epic, a Steward's
//! proposed changes reach Butler, and Butler can apply them.
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
const CREATED: [&str; 3] = ["가입 흐름 정리", "알림 설정 추가", "검색 속도 개선"];
const PROPOSED: [&str; 2] = ["오프라인 모드", "데이터 내보내기"];
const APPLIED: &str = "조사 결과의 과제 두 개를 등록했습니다.";

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

fn tool<'a>(request: &'a Value, name: &str) -> Option<&'a Value> {
    functions(request).find(|tool| tool["name"] == name)
}

fn description<'a>(request: &'a Value, name: &str) -> &'a str {
    tool(request, name).unwrap_or_else(|| panic!("{name} is offered"))["description"]
        .as_str()
        .unwrap()
}

/// Whichever Ledger tools a surface offers say the Ledger is internal.
fn assert_ledger_contract(request: &Value) {
    for name in [
        "project_ledger_create",
        "project_ledger_list",
        "project_ledger_show",
        "project_ledger_update",
    ] {
        if let Some(ledger) = tool(request, name) {
            let text = ledger["description"].as_str().unwrap();
            assert!(
                text.contains("The Ledger is internal work-tracking"),
                "{name}"
            );
            eprintln!("CANON_ROUTING ledger tool offered: {name}");
        }
    }
}

/// What Butler reads before its first call in a project chat.
fn assert_butler_surface(request: &Value) {
    let instructions = request["instructions"].as_str().unwrap();
    let rule = instructions
        .find("- Canon is yours too: register or change the project's canon epics")
        .unwrap_or_else(|| panic!("canon routing rule in: {instructions}"));
    let direct = instructions.find("- Do it yourself, no Work:").unwrap();
    let delegate = instructions
        .find("- Delegate with one delegate_to_steward call:")
        .unwrap();
    assert!(
        direct < rule && rule < delegate,
        "the canon rule is part of the route decision, before the delegation list"
    );
    assert!(instructions[rule..delegate].contains(
        "with one canon_propose call, even for many changes at once; a Steward cannot change canon"
    ));
    assert!(instructions[rule..delegate].contains(
        "If research must come first, delegate only that, then apply its result with canon_propose"
    ));
    assert!(tool(request, "canon_propose").is_some());
    assert!(
        description(request, "delegate_to_steward")
            .contains("A Steward cannot read or change canon")
    );
    assert_ledger_contract(request);
    let input = request["input"].to_string();
    assert!(
        input.contains("## Canon in this project"),
        "a project chat shows canon before any epic is bound"
    );
    assert!(!input.contains("## Canon epics in this conversation"));
}

/// What the Steward reads: no canon tools, and the hand-back rule.
fn assert_steward_surface(request: &Value) {
    let names: Vec<_> = functions(request)
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(
        !names.iter().any(|name| name.starts_with("canon_")),
        "{names:?}"
    );
    let instructions = request["instructions"].as_str().unwrap();
    assert!(instructions.contains("You have no canon tools. If the outcome needs canon changes"));
    assert!(instructions.contains(
        "return the proposed changes in your report for Butler to apply, not as Ledger records."
    ));
    assert_ledger_contract(request);
    assert!(
        !request["input"]
            .to_string()
            .contains("## Canon in this project")
    );
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

#[tokio::test]
async fn project_chat_registers_several_epics_with_one_canon_call() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("CANON-ROUTING")?
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
    let routed = script.requests.lock().unwrap().clone();
    let first_round = routed
        .iter()
        .find(|request| stub::asks(request, CREATE))
        .expect("Butler's first round for the request");
    assert_butler_surface(first_round);
    let first: Vec<_> = calls(&s)?
        .into_iter()
        .filter(|(turn, _, _)| *turn == turn_id)
        .collect();
    let canon: Vec<_> = first
        .iter()
        .filter(|(_, name, _)| name == "canon_propose")
        .collect();
    assert_eq!(canon.len(), 1, "{first:?}");
    assert_eq!(epic_creates(&canon[0].2), CREATED);
    assert!(
        !first
            .iter()
            .any(|(_, name, _)| name == "delegate_to_steward")
    );
    let mut expected: Vec<String> = CREATED.iter().map(|title| (*title).to_owned()).collect();
    expected.sort();
    assert_eq!(backlog(&s, &project).await?, expected);

    let (_, turn) = s.turn(&chat, RESEARCH).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    wait_applied(&s, &chat).await?;
    let requests = script.requests.lock().unwrap().clone();
    let steward: Vec<_> = requests.iter().filter(|r| stub::steward(r)).collect();
    assert!(!steward.is_empty(), "the research ran in a Steward");
    for request in &steward {
        assert_steward_surface(request);
    }
    let returning = requests
        .iter()
        .find(|request| stub::returning(request))
        .expect("Butler received the Steward's result");
    assert!(
        returning["input"].to_string().contains(stub::REPORT),
        "the Steward's proposed changes reach Butler"
    );
    assert!(tool(returning, "canon_propose").is_some());

    let all = calls(&s)?;
    let proposals: Vec<_> = all
        .iter()
        .filter(|(_, name, _)| name == "canon_propose")
        .collect();
    assert_eq!(
        proposals.len(),
        2,
        "one call for the request, one for the research result"
    );
    assert_eq!(epic_creates(&proposals[1].2), PROPOSED);
    assert!(
        !all.iter()
            .any(|(_, name, args)| name == "project_ledger_create" && args["kind"] == "work"),
        "no Ledger Work stands in for a 과제"
    );
    expected.extend(PROPOSED.iter().map(|title| (*title).to_owned()));
    expected.sort();
    assert_eq!(backlog(&s, &project).await?, expected);
    server.abort();
    s.finish().await
}
