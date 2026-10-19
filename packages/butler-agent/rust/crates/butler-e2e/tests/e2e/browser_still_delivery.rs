//! Late stills retain act/step order and every pending item survives restart as a fact.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Setup, accepted_turn_id},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn browser_still_delivery_orders_late_uploads_and_recovers_full_queue()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-STILL-DELIVERY")?
        .stub_cassette(delivery_cassette()?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let tabs = json!({"tabs":[{"id":"page","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","url":"https://example.com"}]});
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/events",
                Some(tabs),
                &[]
            )
            .await?
            .status,
        200
    );
    let accepted = s.gw.say("general", "Browser still delivery").await?;
    let turn = accepted_turn_id(&accepted)?;
    let mut buffer = String::new();
    let frame = serve_until_act(&mut stream, &mut buffer, &admin).await?;
    let id = frame["id"].as_str().unwrap();
    // The reply precedes every still: no capture/upload is needed to acknowledge dispatch.
    let result = json!({"status":"ok","tab":"page","completed":3,"steps":[{"status":"completed"},{"status":"completed"},{"status":"completed"}]});
    assert_eq!(
        admin
            .send(
                Method::POST,
                &format!("/internal/browser-host/results/{id}"),
                Some(result),
                &[]
            )
            .await?
            .status,
        200
    );
    loop {
        let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        if frame["op"] == "use.finished" {
            break;
        }
        if frame["op"] == "tab.waiting" {
            answer(&admin, &frame, json!({"status":"ok"})).await?;
        }
    }
    s.gw.wait_turn("general", &turn, &["delivered"], Duration::from_secs(30))
        .await?;
    // The timeline's act receipt already exists, before any still upload.
    let view = s.gw.get("/session-view?session_id=general").await?;
    let row = act_row(view.data()).expect("browser act in the timeline");
    assert!(
        s.provider()?
            .requests()
            .iter()
            .all(|r| !r["input"].to_string().contains("still_pending")),
        "model-visible results are unchanged"
    );
    let path = format!("/browser-stills/{id}?session_id=general");
    let before = s.gw.get(&path).await?;
    assert_eq!(before.status, 200, "{}", before.text);
    assert!(
        before.data()["steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["state"] == "pending")
    );
    // Deliberately reverse upload order; the timeline projection must retain step order.
    for index in [2, 0] {
        let value = json!({"session":"general","tab":"page","act_id":id,"step":index,
            "still":{"mime":"image/jpeg","base64":STANDARD.encode(still_bytes())}});
        let reply = admin
            .send(
                Method::POST,
                "/internal/browser-host/stills",
                Some(value),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
    }
    let after = s.gw.get(&path).await?.data().clone();
    assert_eq!(after["steps"][0]["step"], 0);
    assert_eq!(after["steps"][0]["state"], "attached");
    assert_eq!(after["steps"][1]["state"], "pending");
    assert_eq!(after["steps"][2]["state"], "attached");
    for index in [0, 2] {
        let path = after["steps"][index]["still_file"]["url"].as_str().unwrap();
        let response = reqwest::Client::new()
            .get(format!("{}{path}", s.gw.base))
            .bearer_auth(&s.gw.token)
            .send()
            .await?;
        assert_eq!(response.status(), 200);
        assert_eq!(response.bytes().await?.as_ref(), still_bytes());
    }
    drop(stream);
    s.crash_and_restart().await?;
    let recovered = s.gw.get(&path).await?.data().clone();
    assert_eq!(recovered["steps"][0]["state"], "attached");
    assert_eq!(recovered["steps"][1]["state"], "failed");
    assert_eq!(recovered["steps"][1]["reason"], "gateway_restarted");
    assert_eq!(recovered["steps"][2]["state"], "attached");
    let raw =
        s.gw.get(&format!(
            "/turns/{turn}/operations/{}/output?result_id={}&offset=0",
            row["tool_call_id"].as_str().unwrap(),
            row["tool_result_id"].as_str().unwrap()
        ))
        .await?;
    let act: Value = serde_json::from_str(raw.data()["content"].as_str().unwrap()).unwrap();
    assert_eq!(act["still_pending"]["id"], id);
    assert_eq!(raw.data()["browser_stills"]["act_id"], id);
    assert_eq!(
        raw.data()["browser_stills"]["steps"][0]["state"],
        "attached"
    );
    assert_eq!(
        raw.data()["browser_stills"]["steps"][1]["reason"],
        "gateway_restarted"
    );

    s.finish().await
}

fn still_bytes() -> Vec<u8> {
    let image = image::RgbImage::from_pixel(16, 10, image::Rgb([20, 80, 160]));
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .unwrap();
    out.into_inner()
}

#[tokio::test]
async fn browser_still_shutdown_recovers_active_and_further_pending_stills()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-STILL-SHUTDOWN")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(admin.send(Method::POST, "/internal/browser-host/events", Some(json!({"tabs":[{
        "id":"page","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","url":"https://example.com"
    }]})), &[]).await?.status, 200);
    let caller = admin.clone();
    let pending = tokio::spawn(async move {
        caller.send(Method::POST, "/internal/browser/calls", Some(json!({
        "op":"tab.act","session":"general","tab":"page","args":{"steps":[{"action":"click","ref":"e1"},{"action":"click","ref":"e2"},{"action":"click","ref":"e3"}]}
    })), &[]).await
    });
    let mut buffer = String::new();
    let frame = loop {
        let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        if frame["op"] == "tab.act" {
            break frame;
        }
    };
    let id = frame["id"].as_str().unwrap();
    let path = format!("/browser-stills/{id}?session_id=general");
    let before = s.gw.get(&path).await?;
    assert_eq!(before.status, 200, "{}", before.text);
    assert_eq!(before.data()["steps"].as_array().unwrap().len(), 3);
    assert!(
        before.data()["steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["state"] == "pending")
    );
    // Shutdown in the active act, before even its acknowledgement or any upload.
    s.restart().await?;
    let _ = pending.await.unwrap()?;
    drop(stream);
    let after = s.gw.get(&path).await?.data().clone();
    assert_eq!(after["steps"].as_array().unwrap().len(), 3);
    for (index, step) in after["steps"].as_array().unwrap().iter().enumerate() {
        assert_eq!(step["step"], index);
        assert_eq!(step["state"], "failed");
        assert_eq!(step["reason"], "gateway_restarted");
    }
    s.finish().await
}

fn act_row(value: &Value) -> Option<&Value> {
    if value["safe_tool_name"] == "browser_act" && value["tool_result_id"].is_string() {
        return Some(value);
    }
    match value {
        Value::Array(items) => items.iter().find_map(act_row),
        Value::Object(items) => items.values().find_map(act_row),
        _ => None,
    }
}

async fn answer(admin: &AdminClient, frame: &Value, result: Value) -> Result<(), HarnessError> {
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
    Ok(())
}

async fn serve_until_act(
    stream: &mut reqwest::Response,
    buffer: &mut String,
    admin: &AdminClient,
) -> Result<Value, HarnessError> {
    loop {
        let frame = super::browser_delegation::next_frame(stream, buffer).await?;
        let result = match frame["op"].as_str().unwrap() {
            "tab.act" => return Ok(frame),
            "tab.open" => json!({"status":"ok","tab":"page","url":"https://example.com"}),
            "tab.observe" => {
                json!({"status":"ok","tab":"page","obs":"obs-1","url":"https://example.com", "text":"button Ready [e1]",
                "image":{"mime_type":"image/jpeg","data":STANDARD.encode(still_bytes())}})
            }
            "tab.prepare" => {
                json!({"status":"ok","tab":"page","url":"https://example.com","steps":[
                {"hit":{"role":"button","name":"Ready"}}, {"hit":{"role":"button","name":"Ready"}}, {"hit":{"role":"button","name":"Ready"}}]})
            }
            "tab.waiting" => json!({"status":"ok"}),
            _ => continue,
        };
        answer(admin, &frame, result).await?;
    }
}

fn delivery_cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = [
        (
            "tool_describe",
            json!({"ids":["native:browser_open","native:browser_observe","native:browser_act"]}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_open","arguments":{"url":"https://example.com"}}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_observe","arguments":{"tab":"page"}}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_act","arguments":{"tab":"page","observation":"obs-1","steps":[
            {"action":"click","ref":"e1"},{"action":"click","ref":"e1"},{"action":"click","ref":"e1"}]}}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, arguments)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = "Browser still delivery".into();
        exchange.request.key.round = round.clone();
        exchange.response = super::browser_usage::stub::response(
            &json!({"type":"function_call","id":format!("fc_delivery_{index}"),
            "call_id":format!("call_delivery_{index}"),"name":name,"arguments":arguments.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = "Browser still delivery".into();
    last.request.key.round = round;
    last.response = super::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_delivery","role":"assistant","status":"completed", "content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}
