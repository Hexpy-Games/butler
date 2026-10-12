//! Collected child assets become a durable parent answer and signed App images.
use super::*;
use std::sync::Arc;

pub(crate) fn parent_item(body: &Value, step: &mut usize) -> Value {
    let current = *step;
    *step += 1;
    let (name, args) = match current {
        0 => ("tool_describe", json!({"ids":["native:browser_open"]})),
        1 => (
            "tool_call",
            json!({"id":"native:browser_open","arguments":{"url":"https://example.com/"}}),
        ),
        2 => {
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
                    {"title":"First image","img":ids[0],"source":"https://example.com/","checked":chrono::Utc::now().to_rfc3339(),"value":{"amount":2,"unit":"items"}},
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
    let mut s = Setup::new("ANSWER-BLOCKS-COLLECTED")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let host = tokio::spawn(serve_host(stream, admin, true));
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(30), host)
        .await
        .unwrap()
        .unwrap()?;
    let message = wait_answer(&s, &script).await?;
    let sets = &message["answer_blocks"];
    assert_eq!(sets[0]["spec"]["blocks"].as_array().unwrap().len(), 3);
    for (index, item) in sets[0]["spec"]["blocks"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let signed = item["image_url"].as_str().unwrap();
        assert!(signed.starts_with(&format!(
            "/assets/{}?expires=",
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
    s.restart().await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
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
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn wait_answer(
    s: &butler_e2e::e2e::scenario::Scenario,
    script: &Arc<stub::Script>,
) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Some(message) = s.gw.messages("general").await?.into_iter().find(|m| {
                m["status"] == "delivered"
                    && m["answer_blocks"]
                        .as_array()
                        .is_some_and(|sets| !sets.is_empty())
            }) {
                assert!(
                    script
                        .requests
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|r| r.to_string().contains("image_assets:"))
                );
                return Ok(message);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap()
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
