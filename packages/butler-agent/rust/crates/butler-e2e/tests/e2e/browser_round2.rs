//! Site notes as data, close-ups that keep acting coordinates, history steps and
//! workspace-only uploads, through the public browser tools.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn browser_site_notes_zoom_history_and_upload_scope() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BROWSER-ROUND2")?.stub_cassette(cassette()?);
    let notes = setup.sandbox.data.join("browser/site-notes");
    std::fs::create_dir_all(&notes)?;
    std::fs::write(
        notes.join("example.com.md"),
        "Owner note: the search box is at the top.",
    )?;
    std::fs::create_dir_all(setup.sandbox.data.join("auth"))?;
    std::fs::write(setup.sandbox.data.join("auth/token.json"), "{}")?;
    std::fs::write(setup.sandbox.data.join("../outside.txt"), "outside")?;
    let s = setup.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let host = tokio::spawn(serve_host(stream, admin));
    s.turn("general", "Browser round two").await?;
    let ops = tokio::time::timeout(Duration::from_secs(10), host)
        .await
        .unwrap()
        .unwrap()?;
    assert_eq!(
        ops,
        [
            "tab.open",
            "tab.observe",
            "tab.zoom",
            "tab.observe",
            "tab.prepare",
            "tab.act"
        ],
        "refused uploads never reach the App"
    );
    let requests = s.provider()?.requests();
    let search = output(&requests[1]);
    assert!(
        search["output"]["other_matches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["id"] == "native:browser_observe"),
        "a category guess that matches something else still shows the browser tools"
    );
    let opened = output(&requests[3]);
    assert_eq!(
        opened["output"]["site_note"]["note"],
        "Owner note: the search box is at the top."
    );
    let zoom = output(&requests[5]);
    assert_eq!(zoom["output"]["schema"], "butler.browser-zoom.v1");
    assert!(zoom["output"]["mapping"].as_str().unwrap().contains("o1"));
    for (index, reason) in [
        (7, "upload_outside_workspace"),
        (8, "upload_sensitive_file"),
    ] {
        assert_eq!(output(&requests[index])["output"]["reason"], reason);
    }
    let last = requests.last().unwrap();
    assert!(
        last.to_string().contains("An older close-up"),
        "a newer observation supersedes the close-up pixels"
    );
    let images = last["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["output"].to_string().contains("input_image"))
        .count();
    assert_eq!(images, 1, "only the newest observation keeps pixels");
    s.finish().await
}

fn output(request: &Value) -> Value {
    let item = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|item| item["type"] == "function_call_output")
        .unwrap();
    let text = item["output"].as_array().map_or_else(
        || item["output"].as_str().unwrap().to_owned(),
        |parts| {
            parts.iter().find(|p| p["type"] == "input_text").unwrap()["text"]
                .as_str()
                .unwrap()
                .to_owned()
        },
    );
    serde_json::from_str(&text).unwrap()
}

async fn serve_host(
    mut stream: reqwest::Response,
    admin: AdminClient,
) -> Result<Vec<String>, HarnessError> {
    let mut buffer = String::new();
    let mut ops = Vec::new();
    let mut observations = 0;
    let pixels = STANDARD.encode(include_bytes!(
        "../../fixtures/browser-route/observation.jpg"
    ));
    loop {
        let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        let op = frame["op"].as_str().unwrap().to_owned();
        match op.as_str() {
            "use.started" | "use.ended" => continue,
            "use.finished" => return Ok(ops),
            "tab.waiting" => (),
            _ => ops.push(op.clone()),
        }
        let result = match op.as_str() {
            "tab.waiting" => json!({"status":"ok"}),
            "tab.open" => {
                let tab = json!({"id":"t1","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"url":"https://example.com/form"});
                admin
                    .send(
                        Method::POST,
                        "/internal/browser-host/events",
                        Some(json!({"tabs":[tab]})),
                        &[],
                    )
                    .await?;
                json!({"status":"ok","tab":"t1","url":"https://example.com/form"})
            }
            "tab.observe" => {
                observations += 1;
                json!({"status":"ok","tab":"t1","obs":format!("o{observations}"),"url":"https://example.com/form",
                    "text":"button \"Upload\" [f0-e1] state=focused","image":{"mime_type":"image/jpeg","data":pixels}})
            }
            "tab.zoom" => {
                assert_eq!(frame["args"]["region"], json!([10, 10, 100, 50]));
                json!({"status":"ok","tab":"t1","url":"https://example.com/form","source_observation":"o1",
                    "mapping":"A pixel (u,v) here is observation point [10+u*100/300, 10+v*50/150]; act with observation o1 coordinates.",
                    "image":{"mime_type":"image/jpeg","data":pixels}})
            }
            "tab.prepare" => {
                assert_eq!(frame["args"]["steps"][0]["action"], "back");
                json!({"status":"ok","tab":"t1","url":"https://example.com/form","steps":[{"hit":{"role":"navigation","name":"https://example.com/","frame":""}}]})
            }
            "tab.act" => {
                json!({"status":"ok","tab":"t1","url":"https://example.com/","completed":1,"steps":[{"status":"completed","hit":{"role":"navigation","name":"https://example.com/"}}]})
            }
            _ => panic!("unexpected browser op {op}"),
        };
        let response = admin
            .send(
                Method::POST,
                &format!(
                    "/internal/browser-host/results/{}",
                    frame["id"].as_str().unwrap()
                ),
                Some(result),
                &[],
            )
            .await?;
        assert_eq!(response.status, 200, "{}", response.text);
    }
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let upload = |path: &str| json!({"tab":"t1","observation":"o2","steps":[{"action":"upload","ref":"f0-e1","value":path}]});
    let calls = [
        (
            "tool_search",
            json!({"query":"browser page click screenshot","category":"automation","limit":10}),
        ),
        (
            "tool_describe",
            json!({"ids":["native:browser_open","native:browser_observe","native:browser_act"]}),
        ),
        ("browser_open", json!({"url":"https://example.com/form"})),
        ("browser_observe", json!({"tab":"t1"})),
        (
            "browser_observe",
            json!({"tab":"t1","region":[10,10,100,50],"scale":3}),
        ),
        ("browser_observe", json!({"tab":"t1"})),
        ("browser_act", upload("../outside.txt")),
        ("browser_act", upload("auth/token.json")),
        (
            "browser_act",
            json!({"tab":"t1","observation":"o2","steps":[{"action":"back"}]}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = "Browser round two".into();
        exchange.request.key.round = round.clone();
        let (tool, args) = if matches!(name, "tool_search" | "tool_describe") {
            (name, args)
        } else {
            (
                "tool_call",
                json!({"id":format!("native:{name}"),"arguments":args}),
            )
        };
        exchange.response = super::browser_usage::stub::response(
            &json!({"type":"function_call","id":format!("fc_r2_{index}"),"call_id":format!("call_r2_{index}"),"name":tool,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = "Browser round two".into();
    last.request.key.round = round;
    last.response = super::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_r2","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}
