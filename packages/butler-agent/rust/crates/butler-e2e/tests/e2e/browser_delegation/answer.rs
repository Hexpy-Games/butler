//! Collected child assets become a durable parent answer and signed App images.
use super::*;
use std::sync::Arc;

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
                json!({"v":1,"blocks":[
                {"type":"cards","items":[
                    {"title":"First image","img":ids[0],"source":"https://example.com/","checked":chrono::Utc::now().with_timezone(&chrono::FixedOffset::east_opt(5 * 3600 + 45 * 60).unwrap()).to_rfc3339(),"value":{"amount":2,"unit":"items"}},
                    {"title":"Second image","img":ids[1]}]},
                {"type":"gallery","items":[{"img":ids[0],"caption":"First image"},{"img":ids[1],"caption":"Second image"}]},
                {"type":"table","columns":["Image","Count"],"rows":[["First",1],["Second",1]]}]}),
            )
        }
        _ => {
            return json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Two images compared.","annotations":[]}]});
        }
    };
    json!({"type":"function_call","id":format!("parent-{current}"),"call_id":format!("parent-{current}"),"name":name,"arguments":args.to_string(),"status":"completed"})
}

#[tokio::test]
async fn collected_child_images_reopen_as_parent_answer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script.browser.store(true, Ordering::SeqCst);
    script.answer_blocks.store(true, Ordering::SeqCst);
    let setup = Setup::new("ANSWER-BLOCKS-COLLECTED")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
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
    let sets = &message["answer_blocks"];
    assert_eq!(sets[0]["spec"]["blocks"].as_array().unwrap().len(), 3);
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
    verify_asset_sweep(&s, &session, &reopened).await?;
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
                .is_some_and(|text| text.contains("Steward role"))
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
    assert!(
        requests.iter().any(|r| r
            .to_string()
            .contains("when your Plan's Presentation line names blocks, present the result with them as planned")),
        "the final-report round presents as planned"
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
    let blocks = result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "answer_blocks")
        .expect("parent is offered answer_blocks");
    assert!(
        blocks["description"]
            .as_str()
            .unwrap()
            .contains("Use it unasked as the Plan's Presentation line decided"),
        "{blocks}"
    );
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

/// Use an actual Vite build asset, without bundling the UI into every scenario.
fn install_ui_asset(setup: &Setup) -> Result<(String, Vec<u8>), HarnessError> {
    let dist =
        butler_e2e::e2e::binary::workspace_root().join("../../butler-app/client/ui/dist/assets");
    let source = std::fs::read_dir(dist)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .find(|entry| entry.path().extension().is_some_and(|ext| ext == "js"))
        .expect("Build the App UI before the collected-answer E2E")
        .path();
    let name = source.file_name().unwrap().to_str().unwrap();
    let target = setup.sandbox.resources.join("app-client/dist/assets");
    std::fs::create_dir_all(&target)?;
    let bytes = std::fs::read(&source)?;
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

async fn verify_asset_sweep(
    s: &butler_e2e::e2e::scenario::Scenario,
    session: &str,
    message: &Value,
) -> Result<(), HarnessError> {
    let items = message["answer_blocks"][0]["spec"]["blocks"][0]["items"]
        .as_array()
        .unwrap();
    for item in items {
        let response = reqwest::get(format!(
            "{}{}",
            s.gw.base,
            item["image_url"].as_str().unwrap()
        ))
        .await?;
        assert_eq!(response.status(), 200, "Reopened image remains loadable");
    }
    assert_eq!(
        s.gw.delete(&format!("/sessions/{session}?permanent=true"))
            .await?
            .status,
        200
    );
    for item in items {
        let response = reqwest::get(format!(
            "{}{}",
            s.gw.base,
            item["image_url"].as_str().unwrap()
        ))
        .await?;
        assert_eq!(
            response.status(),
            404,
            "Deleted chat sweeps its collected image"
        );
    }
    Ok(())
}
