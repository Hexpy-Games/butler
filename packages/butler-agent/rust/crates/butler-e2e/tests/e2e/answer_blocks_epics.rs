//! Epic answer blocks use the real app canon boundary, including cross-project reads.
use super::*;
use crate::canon_registration::stub;
use butler_e2e::e2e::{
    gateway::Reply,
    scenario::{Access, Scenario},
};

fn data(reply: Reply, status: u16) -> Value {
    assert_eq!(reply.status, status, "{}", reply.text);
    let mut body = reply.body;
    body["data"].take()
}
fn spec(project: &str, ids: &[&str]) -> Value {
    json!({"v":2,"blocks":[{"type":"epics","project_id":project,"ids":ids}]})
}
async fn send(
    s: &Scenario,
    script: &stub::Script,
    chat: &str,
    prompt: &str,
    calls: Vec<(&str, Value)>,
) -> Result<String, HarnessError> {
    stub::arm(script, prompt, calls);
    let (id, turn) = s.turn(chat, prompt).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    Ok(id)
}
async fn create_project(s: &Scenario, name: &str) -> Result<String, HarnessError> {
    Ok(data(
        s.gw.post("/projects", json!({"source":"scratch","display_name":name}))
            .await?,
        201,
    )["project"]["id"]
        .as_str()
        .unwrap()
        .into())
}
async fn create_epic(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Review release","description":"Check readiness"}),
        )
        .await?,
        201,
    ))
}
fn rejected(script: &stub::Script, fix: &str) {
    let results = stub::results(script);
    let result = results.last().unwrap();
    assert_eq!(result["error"]["code"], "invalid_blocks", "{result}");
    assert!(
        result["error"]["problems"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["path"] == "/blocks/0/ids/0" && p["fix"].as_str().unwrap().contains(fix)),
        "{result}"
    );
}
async fn delivered(
    s: &Scenario,
    chat: &str,
    turn: &str,
    expected: &Value,
) -> Result<(), HarnessError> {
    let messages = s.gw.messages(chat).await?;
    let reply = messages
        .iter()
        .find(|m| m["turn_id"] == turn && m["role"] == "assistant" && m["status"] == "delivered")
        .unwrap();
    assert_eq!(&reply["answer_blocks"][0]["spec"], expected);
    Ok(())
}

#[tokio::test]
async fn epic_ids_validate_and_deliver_without_board_snapshots() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("ANSWER-EPICS")?
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    let project = create_project(&s, "Release").await?;
    let other = create_project(&s, "Documentation").await?;
    let epic = create_epic(&s, &project).await?;
    let foreign = create_epic(&s, &other).await?;
    let deleted = create_epic(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    let other_id = foreign["id"].as_str().unwrap();
    let chat = data(
        s.gw.post(&format!("/canon/epics/{id}/conversation"), json!({}))
            .await?,
        200,
    )["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let valid = spec(&project, &[id]);
    let turn = send(
        &s,
        &script,
        &chat,
        "Show the requested task",
        vec![("answer_blocks", valid.clone())],
    )
    .await?;
    delivered(&s, &chat, &turn, &valid).await?;
    send(
        &s,
        &script,
        &chat,
        "Check an unknown task",
        vec![("answer_blocks", spec(&project, &["missing"]))],
    )
    .await?;
    rejected(&script, "unknown or deleted epic id");
    data(
        s.gw.send(
            reqwest::Method::DELETE,
            &format!("/canon/epics/{}", deleted["id"].as_str().unwrap()),
            Some(json!({"expected_revision":deleted["revision"]}).to_string()),
        )
        .await?,
        200,
    );
    send(
        &s,
        &script,
        &chat,
        "Check the deleted task",
        vec![(
            "answer_blocks",
            spec(&project, &[deleted["id"].as_str().unwrap()]),
        )],
    )
    .await?;
    rejected(&script, "unknown or deleted epic id");
    send(
        &s,
        &script,
        &chat,
        "Check project identity",
        vec![("answer_blocks", spec(&project, &[other_id]))],
    )
    .await?;
    rejected(&script, &format!("this epic is in project {other}"));
    let cross = spec(&other, &[other_id]);
    let turn = send(
        &s,
        &script,
        &chat,
        "Show the documentation task",
        vec![("answer_blocks", cross.clone())],
    )
    .await?;
    delivered(&s, &chat, &turn, &cross).await?;
    send(
        &s,
        &script,
        &chat,
        "Check duplicate tasks",
        vec![("answer_blocks", spec(&project, &[id, id]))],
    )
    .await?;
    assert!(
        stub::results(&script).iter().any(|r| r["error"]["problems"]
            .as_array()
            .is_some_and(|ps| ps.iter().any(|p| p["path"] == "/blocks/0/ids/1"
                && p["fix"].as_str().unwrap().contains("duplicate"))))
    );
    assert_tool(&script);
    s.finish().await?;
    server.abort();
    Ok(())
}
fn assert_tool(script: &stub::Script) {
    let schema: Value =
        serde_json::from_str(butler_runtime::capabilities::answer_blocks::ANSWER_BLOCKS_SCHEMA)
            .unwrap();
    let requests = script.requests.lock().unwrap();
    let tool = butler_e2e::e2e::chatgpt_wire::tools(&requests[0])
        .find(|t| t["name"] == "answer_blocks")
        .unwrap();
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../butler-runtime/src/capabilities/catalog/catalog.json"
    ))
    .unwrap();
    assert_eq!(
        tool["description"],
        catalog["rawDefinitions"]["answer_blocks"]["description"]
    );
    assert_eq!(
        tool["parameters"]["$defs"]["epics"],
        schema["$defs"]["epics"]
    );
}

#[tokio::test]
async fn applied_proposal_exposes_created_ids_for_answer_cards() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("ANSWER-CREATED-EPICS")?
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    let project = create_project(&s, "New release").await?;
    let chat = data(
        s.gw.post("/sessions", json!({"title":"Registration","kind":"chat"}))
            .await?,
        201,
    )["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    send(&s, &script, &chat, "Create and show a task", vec![
        ("canon_propose", json!({"project_id":project,"summary":"Release check","changes":[{"op":"epic.create","title":"Check release"}]})),
        ("answer_blocks", spec(&project, &["$epic"]))
    ]).await?;
    let results = stub::results(&script);
    let applied = results.iter().find(|r| r["state"] == "applied").unwrap();
    let epic = applied["bound"][0]
        .as_str()
        .unwrap()
        .trim_start_matches("canon:epic/");
    assert!(
        results
            .iter()
            .any(|r| r["ok"] == true && r["shown"]["epics"] == 1),
        "{results:?}"
    );
    let view = data(
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?,
        200,
    );
    let proposal = view["canon_proposals"][0]["proposal_id"].as_str().unwrap();
    let proposal = data(
        s.gw.get(&format!("/canon/proposals/{proposal}")).await?,
        200,
    );
    assert_eq!(proposal["state"], "applied");
    assert_eq!(proposal["changes"][0]["id"], epic);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[test]
fn epic_tool_tokens_stay_within_existing_budget() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../butler-runtime/src/capabilities/catalog/catalog.json"
    ))?;
    let description = catalog["rawDefinitions"]["answer_blocks"]["description"]
        .as_str()
        .unwrap();
    let schema: Value =
        serde_json::from_str(butler_runtime::capabilities::answer_blocks::ANSWER_BLOCKS_SCHEMA)?;
    let tokenizer = tiktoken_rs::o200k_base_singleton();
    let description_tokens = tokenizer.encode_ordinary(description).len();
    let schema_tokens = tokenizer.encode_ordinary(&schema.to_string()).len();
    eprintln!(
        "ANSWER_BLOCKS_TOKENS before=227+2776=3003 after={description_tokens}+{schema_tokens}={}",
        description_tokens + schema_tokens
    );
    assert!(description_tokens + schema_tokens <= 3003);
    Ok(())
}
