//! Collected child assets become a durable parent answer and signed App images.
use super::*;
use std::sync::Arc;

/// A Markdown table naming the same rows as the answer's table block.
const REPEATED_TABLE: &str =
    "| Image | Count |\n|---|---:|\n| **First** | 1 |\n| [Second](https://example.com/) | 1 |";
/// A Markdown table of other rows, which no block shows.
const OTHER_TABLE: &str = "| Step | Result |\n|---|---|\n| Collect | Done |";

pub(crate) fn parent_item(body: &Value, step: &mut usize) -> Value {
    let current = *step;
    *step += 1;
    // The parent cites the page only its steward read: delegated reads are
    // this conversation's provenance.
    let (name, args) = match current {
        0 => {
            let pattern = regex::Regex::new(r"img_[a-z0-9]{10,12}").unwrap();
            let mut ids = pattern
                .find_iter(&body.to_string())
                .map(|m| m.as_str().to_owned())
                .collect::<Vec<_>>();
            ids.sort();
            ids.dedup();
            assert_eq!(ids.len(), 2, "parent received two collected ids");
            (
                "answer_blocks",
                with_v2_children(
                    json!({"v":2,"blocks":[
                {"type":"cards","items":[
                    {"title":"First image","img":ids[0],"source":"https://example.com/","checked":chrono::Utc::now().with_timezone(&chrono::FixedOffset::east_opt(5 * 3600 + 45 * 60).unwrap()).to_rfc3339(),"value":{"amount":2,"unit":"items"}},
                    {"title":"Second image","img":ids[1]}]},
                {"type":"gallery","items":[{"img":ids[0],"caption":"First image"},{"img":ids[1],"caption":"Second image"}]},
                {"type":"table","columns":["Image","Count"],"rows":[["First",1],["Second",1]]}]}),
                    &ids[0],
                ),
            )
        }
        _ => {
            // The prose repeats the table block row for row; the reply keeps
            // the block and drops the repeated Markdown table.
            return json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":format!("Two images compared.\n\n{REPEATED_TABLE}\n\n{OTHER_TABLE}\n\nBoth were checked."),"annotations":[]}]});
        }
    };
    json!({"type":"function_call","id":format!("parent-{current}"),"call_id":format!("parent-{current}"),"name":name,"arguments":args.to_string(),"status":"completed"})
}

fn with_v2_children(mut spec: Value, image: &str) -> Value {
    let fixture: Value =
        serde_json::from_str(include_str!("../../answer_blocks/fixtures.json")).unwrap();
    let mut blocks = fixture["specs"]["v2"]["blocks"].as_array().unwrap().clone();
    blocks[1]["tabs"][1]["blocks"][0]["img"] = json!(image);
    spec["blocks"].as_array_mut().unwrap().extend(blocks);
    spec
}

#[tokio::test]
async fn collected_child_images_reopen_as_parent_answer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script.browser.store(true, Ordering::SeqCst);
    script.answer_blocks.store(true, Ordering::SeqCst);
    let setup = Setup::mutates_installation("ANSWER-BLOCKS-COLLECTED")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let (static_path, static_bytes) = install_ui_asset(&setup)?;
    let mut s = setup.start().await?;
    let static_file = reqwest::get(format!("{}{static_path}", s.gw.base)).await?;
    assert_eq!(static_file.status(), 200);
    assert_eq!(static_file.bytes().await?.as_ref(), static_bytes.as_slice());
    let chat =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Collected answer"}),
        )
        .await?;
    assert_eq!(chat.status, 201);
    let session = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let host = tokio::spawn(serve_host(stream, admin, true, session.clone()));
    s.turn(&session, stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(30), host)
        .await
        .unwrap()
        .unwrap()?;
    let message = wait_answer(&s, &script, &session).await?;
    let attachments = message["attachments"]
        .as_array()
        .expect("final reply attachments");
    assert_eq!(
        attachments.len(),
        1,
        "the pictured page capture is removed and the other page capture stays: {attachments:?}"
    );
    assert_remaining_capture_source(&s, &session)?;
    assert_eq!(
        message["text"],
        format!("Two images compared.\n\n{OTHER_TABLE}\n\nBoth were checked."),
        "a table shown as a block is not repeated in the prose"
    );
    let sets = &message["answer_blocks"];
    assert_eq!(sets[0]["spec"]["blocks"].as_array().unwrap().len(), 6);
    assert!(
        sets[0]["spec"]["blocks"][0]["items"][0]["checked"]
            .as_str()
            .unwrap()
            .ends_with("+05:45")
    );
    for (index, item) in sets[0]["spec"]["blocks"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let signed = item["image_url"].as_str().unwrap();
        assert!(signed.starts_with(&format!(
            "/message-assets/{}?expires=",
            item["img"].as_str().unwrap()
        )));
        let response = reqwest::get(format!("{}{signed}", s.gw.base)).await?;
        assert_eq!(response.status(), 200);
        if let Ok(dir) = std::env::var("BUTLER_ANSWER_EVIDENCE") {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(
                std::path::Path::new(&dir).join(if index == 0 {
                    "first.jpg"
                } else {
                    "second.jpg"
                }),
                response.bytes().await?,
            )?;
        }
    }
    let image = sets[0]["spec"]["blocks"][0]["items"][0]["img"]
        .as_str()
        .unwrap();
    let mut expected = with_v2_children(json!({"v":2,"blocks":[]}), image);
    butler_runtime::capabilities::answer_blocks::normalize(&mut expected);
    let picture = &mut expected["blocks"][1]["tabs"][1]["blocks"][0];
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let (width, height, ratio): (f64, f64, f64) = db.query_row(
        "SELECT width,height,pixel_ratio FROM app_assets WHERE id=?1",
        [image],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(
        ratio, 2.0,
        "the browser capture ratio reaches durable storage"
    );
    picture["image_width"] = json!((width / ratio).round());
    picture["image_height"] = json!((height / ratio).round());
    drop(db);
    let mut actual = sets[0]["spec"].clone();
    strip_signatures(&mut actual);
    assert_eq!(
        &actual["blocks"].as_array().unwrap()[3..],
        expected["blocks"].as_array().unwrap()
    );
    assert_stored_ids(&s)?;
    assert_request_view_hides_presentation(&s, &session).await?;
    s.restart().await?;
    let view =
        s.gw.get(&format!("/session-view?session_id={session}"))
            .await?;
    let reopened = view.data()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == message["id"])
        .unwrap()
        .clone();
    assert_eq!(
        reopened["answer_blocks"][0]["spec"]["blocks"][2],
        sets[0]["spec"]["blocks"][2]
    );
    let mut before = sets.clone();
    let mut after = reopened["answer_blocks"].clone();
    strip_signatures(&mut before);
    strip_signatures(&mut after);
    assert_eq!(before, after, "entire persisted spec survives restart");
    if let Ok(dir) = std::env::var("BUTLER_ANSWER_EVIDENCE") {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(
            std::path::Path::new(&dir).join("reopened-message.json"),
            serde_json::to_vec_pretty(&reopened)?,
        )?;
    }
    super::super::browser_library::blocks::asset_lifetime(&s, &session, &reopened).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The delegated request view shows the objective and real checks; the
/// planned `Presentation:` line reaches only the model.
async fn assert_request_view_hides_presentation(
    s: &butler_e2e::e2e::scenario::Scenario,
    session: &str,
) -> Result<(), HarnessError> {
    let view =
        s.gw.get(&format!("/session-view?session_id={session}"))
            .await?;
    let child = view.data()["steward_children"][0]["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let view =
        s.gw.get(&format!("/session-view?session_id={child}"))
            .await?;
    let request = view.data()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "user")
        .and_then(|message| message["text"].as_str())
        .unwrap_or_default()
        .to_owned();
    assert!(
        request.contains("• Approach verified") && !request.contains("Presentation:"),
        "delegated request view: {request}"
    );
    Ok(())
}

async fn wait_answer(
    s: &butler_e2e::e2e::scenario::Scenario,
    script: &Arc<stub::Script>,
    session: &str,
) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Some(message) = s.gw.messages(session).await?.into_iter().find(|m| {
                m["status"] == "delivered"
                    && m["answer_blocks"]
                        .as_array()
                        .is_some_and(|sets| !sets.is_empty())
            }) {
                assert_presentation_contract(&script.requests.lock().unwrap());
                return Ok(message);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap()
}

/// The presentation is decided in the parent Plan: the Plan records it, the
/// delegated task asks for per-item facts and one image per item, the parent
/// receives the ids with the instruction to present them, and the reporting
/// round and answer_blocks refer back to the planned blocks.
fn assert_presentation_contract(requests: &[Value]) {
    let steward = requests
        .iter()
        .find(|r| {
            r["instructions"]
                .as_str()
                .is_some_and(|text| text.contains("You run one delegated Work"))
        })
        .expect("a steward request");
    let task = steward["input"].to_string();
    assert!(
        steward
            .to_string()
            .contains("This Turn is already bound to this Work"),
        "a steward starts on its runtime-bound child Work, without a continue_work round"
    );
    assert!(
        task.contains("Presentation: cards, table")
            && task.contains("Butler's Plan presents this result as cards, table")
            && task.contains("collect one representative photo per item with image_collect"),
        "the planned presentation drives the delegated task: {task}"
    );
    // The steward reports without answer blocks: its final-report round
    // neither offers nor names them, so it never searches for them.
    let report = requests
        .iter()
        .filter(|r| r.to_string().contains("You run one delegated Work"))
        .find_map(|r| {
            let input = r["input"].to_string();
            input.contains("Execution is settled").then_some(input)
        })
        .expect("a steward final-report round");
    assert!(
        report.contains("the recipient builds them from your report")
            && !report.contains("except answer_blocks"),
        "steward final report: {report}"
    );
    let result = requests
        .iter()
        .find(|r| r.to_string().contains("image_assets:"))
        .expect("parent received collected ids");
    assert!(
        result
            .to_string()
            .contains("Put them on those items' answer_blocks cards in your own reply"),
        "delivered ids carry the presentation instruction"
    );
    let blocks = butler_e2e::e2e::chatgpt_wire::functions(result)
        .find(|tool| tool["name"] == "answer_blocks")
        .expect("parent is offered answer_blocks");
    let catalog = butler_core::tool_catalog::load().unwrap();
    assert_eq!(
        blocks["parameters"], catalog["rawDefinitions"]["answer_blocks"]["parameters"],
        "the parent receives the complete resolved answer schema"
    );
    assert!(
        blocks["description"]
            .as_str()
            .unwrap()
            .contains("Use it unasked, with or without a Plan")
            && blocks["description"]
                .as_str()
                .unwrap()
                .contains("The blocks are the only copy of what they show"),
        "{blocks}"
    );
    assert_acceptance_contract(result, steward);
}

/// Explicit constraints of the request (counts in the unit it names, each
/// distinct, dates, limits) become Plan checks, travel to the steward as its
/// acceptance criteria, and are what result and completion reviews test.
fn assert_acceptance_contract(parent: &Value, steward: &Value) {
    let tool = |request: &Value, name: &str| {
        butler_e2e::e2e::chatgpt_wire::functions(request)
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} offered"))
            .clone()
    };
    let handoff =
        tool(parent, "delegate_to_steward")["parameters"]["properties"]["checks"]["description"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
    assert!(
        handoff.contains("each explicit constraint in the request its own check")
            && handoff.contains("each observable with a tool")
            && handoff.contains("Steward's acceptance criteria"),
        "{handoff}"
    );
    let checks =
        tool(steward, "replace_work_plan")["parameters"]["properties"]["checks"]["description"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
    assert!(
        checks.contains("Make each explicit constraint in the request its own check")
            && checks.contains("in the unit the request names and each one distinct"),
        "{checks}"
    );
    assert!(
        steward["input"].to_string().contains("Approach verified"),
        "the Plan's checks reach the steward as acceptance criteria"
    );
    for request in [parent, steward] {
        let review = tool(request, "record_work_review")["description"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        assert!(
            review.contains("test the result against each Plan check and each explicit constraint in the request")
                && review.contains("never accept"),
            "{review}"
        );
    }
}

fn strip_signatures(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("image_url");
            for child in object.values_mut() {
                strip_signatures(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_signatures(item);
            }
        }
        _ => {}
    }
}

/// A static App asset served from the installed resources; any bundle file
/// exercises the route, so the scenario needs no prior UI build.
fn install_ui_asset(setup: &Setup) -> Result<(String, Vec<u8>), HarnessError> {
    let name = "collected-answer-fixture.js";
    let bytes = b"export const collectedAnswerFixture = true;\n".to_vec();
    let target = setup.sandbox.resources.join("app-client/dist/assets");
    std::fs::create_dir_all(&target)?;
    std::fs::write(target.join(name), &bytes)?;
    Ok((format!("/assets/{name}"), bytes))
}

fn assert_stored_ids(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let spec: String = db.query_row(
        "SELECT blocks_json FROM messages WHERE blocks_json IS NOT NULL LIMIT 1",
        [],
        |row| row.get(0),
    )?;
    assert!(spec.contains("img_"));
    assert!(!spec.contains("image_url"), "Signed URLs are HTTP metadata");
    assert!(!spec.contains("/assets/"));
    Ok(())
}

fn assert_remaining_capture_source(
    s: &butler_e2e::e2e::scenario::Scenario,
    session: &str,
) -> Result<(), HarnessError> {
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let session_suffix = format!("%{session}");
    let raw: String = db.query_row(
        "SELECT final_payload_json FROM btcc_turns WHERE session_id LIKE ?1 AND final_payload_json IS NOT NULL",
        [session_suffix],
        |row| row.get(0),
    )?;
    let payload: Value = serde_json::from_str(&raw)?;
    let artifacts = payload["artifacts"]
        .as_array()
        .expect("parent final payload artifacts");
    assert_eq!(artifacts.len(), 1, "only the unpictured page capture stays");
    assert_eq!(artifacts[0]["sourceUrl"], "https://example.org/");
    Ok(())
}
