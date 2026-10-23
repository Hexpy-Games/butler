//! Only explicit declarations populate the Library; working bytes remain readable.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
pub(super) mod delegation;
mod handoff;
mod handoff_lifetime;
mod migration;
mod opened_files;
mod paths;
mod security;
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use stub::{call, done};

async fn run_turn(
    s: &Scenario,
    script: &stub::Script,
    prompt: &str,
) -> Result<(String, Value), HarnessError> {
    *script.prompt.lock().unwrap() = prompt.to_owned();
    s.turn("general", prompt).await
}
async fn documents(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let response = s.gw.get("/library?kind=document").await?;
    assert_eq!(response.status, 200, "{response:?}");
    Ok(response.data()["items"].as_array().unwrap().clone())
}
async fn last(s: &Scenario) -> Result<Value, HarnessError> {
    Ok(s.gw
        .messages("general")
        .await?
        .into_iter()
        .rev()
        .find(|m| m["role"] == "assistant" && m["status"] == "delivered")
        .unwrap())
}
fn write(path: &str, text: &str) -> Value {
    call(
        "write_file",
        json!({"path":path,"content":text,"create_parents":true}),
    )
}
fn deliver(path: &str, title: &str) -> Value {
    call(
        "deliver_files",
        json!({"files":[{"path":path,"title":title}]}),
    )
}

#[tokio::test]
async fn research_to_deck_preserves_working_files_and_pairs_changes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-DECK")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url);
    *script.steps.lock().unwrap() = [
        write("notes/research.md", "Research"),
        write("tools/build.sh", "printf '<h1>Deck</h1>' > deck.html\nprintf '{}' > \"$BUTLER_ARTIFACTS_DIR/data.json\"\n"),
        call("run_command", json!({"command":"sh tools/build.sh","state_effect":"mutation","summary":"Create requested files"})),
        deliver("deck.html", "Q3/Q4 Deck"), done(),
    ].into();
    let s = setup.start().await?;
    let (_, turn) = run_turn(&s, &script, "Make a deck.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let docs = documents(&s).await?;
    assert_eq!(docs.len(), 1, "{docs:?}");
    assert_eq!(docs[0]["title"], "Q3/Q4 Deck");
    assert_eq!(docs[0]["file"]["safe_name"], "deck.html");
    assert_eq!(docs[0]["session"], "general");
    let message = last(&s).await?;
    let files = message["attachments"].as_array().unwrap();
    assert_eq!(files.len(), 4, "{message}");
    assert!(files.iter().all(|f| f["source_label"].is_string()));
    assert_eq!(files.iter().filter(|f| f["deliverable"] == true).count(), 1);
    let delivered = files.iter().find(|f| f["deliverable"] == true).unwrap();
    assert_eq!(delivered["safe_name"], "deck.html");
    assert_eq!(delivered["title"], "Q3/Q4 Deck");
    let bytes = s.gw.get(delivered["url"].as_str().unwrap()).await?;
    assert_eq!(bytes.text, "<h1>Deck</h1>");
    let changed = message["changed_files"].as_array().unwrap();
    assert_eq!(changed.len(), 2, "{message}");
    assert!(changed.iter().all(|f| f["file_id"].is_string()));
    let artifacts = s.gw.get("/artifacts?session_id=general").await?;
    assert_eq!(
        artifacts.data()["artifacts"].as_array().unwrap().len(),
        4,
        "{artifacts:?}"
    );
    let projected = artifacts.data();
    let artifact = projected["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["deliverable"] == true)
        .unwrap();
    assert_eq!(artifact["title"], "Q3/Q4 Deck");
    assert_eq!(artifact["safe_path_label"], "deck.html");
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn report_versions_preserve_title_and_unchanged_delivery_is_noop() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-VERSIONS")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url);
    for n in 0..3 {
        std::fs::write(setup.sandbox.data.join(format!("fixture-{n}")), "Input")?;
    }
    *script.steps.lock().unwrap() = [
        call("read_file", json!({"requests":[{"path":"fixture-0"}]})),
        call("read_file", json!({"requests":[{"path":"fixture-1"}]})),
        call("read_file", json!({"requests":[{"path":"fixture-2"}]})),
        write("report.md", "First report"),
        deliver("report.md", "Report"),
        done(),
    ]
    .into();
    let s = setup.start().await?;
    run_turn(&s, &script, "Read then report.").await?;
    let docs = documents(&s).await?;
    assert_eq!(docs.len(), 1);
    let id = docs[0]["id"].as_str().unwrap();
    let bytes = s.gw.get(docs[0]["file"]["url"].as_str().unwrap()).await?;
    assert_eq!(bytes.text, "First report");
    assert!(
        last(&s).await?["changed_files"]
            .as_array()
            .is_none_or(Vec::is_empty)
    );
    assert_eq!(
        s.gw.patch("/library/items", json!({"ids":[id],"title":"My title"}))
            .await?
            .status,
        200
    );
    *script.steps.lock().unwrap() = [
        call(
            "edit_file",
            json!({"path":"report.md","old_text":"First report","new_text":"Second report"}),
        ),
        deliver("report.md", "Report"),
        done(),
    ]
    .into();
    run_turn(&s, &script, "Revise.").await?;
    *script.steps.lock().unwrap() = [deliver("report.md", "Report"), done()].into();
    run_turn(&s, &script, "Deliver again.").await?;
    let docs = documents(&s).await?;
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0]["title"], "My title");
    let revisions = docs[0]["revisions"].as_array().unwrap();
    assert_eq!(revisions.len(), 2, "{docs:?}");
    assert_eq!(
        s.gw.get(revisions[0]["file"]["url"].as_str().unwrap())
            .await?
            .text,
        "Second report"
    );
    assert_eq!(
        s.gw.get(revisions[1]["file"]["url"].as_str().unwrap())
            .await?
            .text,
        "First report"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn working_files_promote_without_losing_bytes_on_card_delete() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    *script.steps.lock().unwrap() = [
        write("src/a.rs", "first"),
        call(
            "edit_file",
            json!({"path":"src/b.rs","old_text":"first","new_text":"second"}),
        ),
        done(),
    ]
    .into();
    let setup = Setup::new("DELIVERABLE-PROMOTE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url);
    std::fs::create_dir_all(setup.sandbox.data.join("src"))?;
    std::fs::write(setup.sandbox.data.join("src/b.rs"), "first")?;
    let s = setup.start().await?;
    run_turn(&s, &script, "Change code.").await?;
    assert_eq!(documents(&s).await?, Vec::<Value>::new());
    let message = last(&s).await?;
    assert_eq!(message["changed_files"].as_array().unwrap().len(), 2);
    assert!(
        message["changed_files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f["file_id"].is_string())
    );
    let file = &message["attachments"][0];
    let response =
        s.gw.post("/library/documents", json!({"file_id":file["file_id"]}))
            .await?;
    assert_eq!(response.status, 200, "{response:?}");
    let again =
        s.gw.post("/library/documents", json!({"file_id":file["file_id"]}))
            .await?;
    assert_eq!(again.status, 200);
    assert_eq!(again.data()["id"], response.data()["id"]);
    assert_eq!(again.data()["revisions"].as_array().unwrap().len(), 1);
    assert_eq!(documents(&s).await?.len(), 1);
    let message = last(&s).await?;
    assert_eq!(message["changed_files"].as_array().unwrap().len(), 1);
    assert_eq!(message["attachments"][0]["deliverable"], true);
    assert_eq!(
        s.gw.delete(&format!(
            "/library/{}",
            response.data()["id"].as_str().unwrap()
        ))
        .await?
        .status,
        200
    );
    assert_eq!(s.gw.get(file["url"].as_str().unwrap()).await?.status, 200);
    assert_eq!(
        s.gw.post("/library/documents", json!({"file_id":"missing"}))
            .await?
            .status,
        404
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn command_declaration_and_missing_file_use_explicit_intent_only() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    *script.steps.lock().unwrap() = [deliver("missing", "Missing"), done()].into();
    let s = Setup::new("DELIVERABLE-COMMAND")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url)
        .start()
        .await?;
    let (turn, _) = run_turn(&s, &script, "Try missing file.").await?;
    assert_eq!(documents(&s).await?, Vec::<Value>::new());
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let raw: String = db.query_row("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='deliver_files'", [&turn], |r| r.get(0)).unwrap();
    let result: Value = serde_json::from_str(&raw)?;
    assert_eq!(result["ok"], false);
    assert_eq!(result["error"], "deliver_file_unavailable");
    drop(db);
    *script.steps.lock().unwrap() = [call("run_command", json!({"command":"printf 'a,b' > \"$BUTLER_ARTIFACTS_DIR/table.csv\"; printf x > \"$BUTLER_ARTIFACTS_DIR/helper\"; printf y > \"$BUTLER_ARTIFACTS_DIR/log\"", "summary":"Create requested files", "output_paths":["artifacts/generated/table.csv"]})), done()].into();
    run_turn(&s, &script, "Create table.").await?;
    let docs = documents(&s).await?;
    assert_eq!(docs.len(), 1, "{docs:?}");
    assert_eq!(docs[0]["source"], "artifacts/generated/table.csv");
    s.finish().await?;
    server.abort();
    Ok(())
}
