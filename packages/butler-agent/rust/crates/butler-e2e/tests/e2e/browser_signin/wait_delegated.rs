use super::host::{admin, attach, snapshot, tab};
use axum::{Json, Router, routing::post};
use butler_e2e::e2e::{
    HarnessError, cassette::Cassette, matching, sanitize::Placeholders, scenario::Setup,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::{sleep, timeout};

const CHECKOUT: &str = "https://www.fixture-shop.test/checkout";
const ASK: &str = "Help me enter the card number";
const ENTERED: &str = "I entered the card number";

#[tokio::test]
async fn delegated_wait_resumes_on_steer_and_on_done() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let relation = Arc::new(Mutex::new(String::new()));
    let requests = Arc::new(Mutex::new(Vec::<(usize, Value)>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/codex", listener.local_addr()?);
    let app = Router::new().route(
        "/codex/responses",
        post({
            let relation = relation.clone();
            let requests = requests.clone();
            move |Json(body): Json<Value>| async move {
                let key = matching::key("/codex/responses", &body, &Placeholders::default());
                let step = key.round.iter().filter(|k| k.as_str() == "function_call_output").count();
                let steward = key.user_request.starts_with("role: steward")
                    || body["instructions"].as_str().unwrap_or("").contains("You run one delegated Work for Butler");
                let call = if steward {
                    requests.lock().unwrap().push((step, body.clone()));
                    match step {
                        0 => Some(("replace_work_plan", json!({"objective":ASK,"execution_mode":"direct","actions":[{"action_key":"enter","description":ASK,"dependency_keys":[]}],"checks":["Input complete"]}))),
                        1 => Some(("record_work_review", json!({"subject":"plan","verdict":"accept","summary":"Ready"}))),
                        2 => Some(("tool_describe", json!({"ids":["native:browser_wait_for_user"]}))),
                        3 | 4 => Some(("tool_call", json!({"id":"native:browser_wait_for_user","arguments":{"tab":"t1","reason":"secure_keypad"}}))),
                        5 => Some(("record_work_disposition", json!({"work_id":crate::steward_presentation::stub::work_id(&body),"disposition":"completed","summary":"Input complete","action_updates":[{"action_key":"enter","status":"done"}],"remaining_actions":[],"followups":[]}))),
                        _ => None,
                    }
                } else {
                    match (key.user_request.as_str(), step) {
                        (ASK, 0) => Some(("delegate_to_steward", json!({"request":ASK,"checks":["Input complete"]}))),
                        (ENTERED, 0) => Some(("steer_steward", json!({"relation_id":relation.lock().unwrap().as_str(),"instruction":ENTERED,"mode":"steer"}))),
                        _ => None,
                    }
                };
                let id = format!("delegated-wait-{steward}-{step}");
                let item = match call {
                    Some((name, args)) => json!({"type":"function_call","id":id,"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"}),
                    None => json!({"type":"message","id":id,"role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
                };
                let response = crate::browser_usage::stub::response(&item);
                ([("content-type", "text/event-stream")], response.chunks.into_iter().map(|c| c.text).collect::<String>())
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let s = Setup::new("BROWSER-WAIT-DELEGATED")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", endpoint)
        .start()
        .await?;
    let admin = admin(&s);
    let host = attach(
        &s,
        Arc::new(|frame: Value| {
            Box::pin(async move {
                if frame["op"] == "tab.wait" {
                    json!({"status":"user_control","tab":frame["tab"],"epoch":1})
                } else {
                    json!({"status":"ok","tab":frame["tab"],"url":CHECKOUT})
                }
            })
        }),
    )
    .await?;
    let tabs = |holder| json!([tab("t1", "conversation:general", CHECKOUT, holder)]);
    snapshot(&admin, tabs("user")).await?;

    s.gw.say_turn("general", ASK).await?;
    let card = timeout(Duration::from_secs(30), async {
        loop {
            if let Some(card) =
                s.gw.approval_requests("general")
                    .await?
                    .into_iter()
                    .find(|card| card["approval"]["operation"]["tool"] == "browser_wait_for_user")
            {
                break Ok::<_, HarnessError>(card);
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("first hand-off card")?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let child = &view.data()["steward_children"][0];
    assert_eq!(card["source_session_id"], child["session_id"]);
    *relation.lock().unwrap() = child["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let turn = s.gw.say_turn("general", ENTERED).await?;
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    let given_back_frames = || {
        host.frames
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame["op"] == "use.given_back" && frame["tab"] == "t1")
            .count()
    };
    timeout(Duration::from_secs(10), async {
        while given_back_frames() == 0 {
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("steering gives back t1");

    snapshot(&admin, tabs("agent")).await?;
    let directed = timeout(Duration::from_secs(30), async {
        loop {
            if let Some(body) = requests
                .lock()
                .unwrap()
                .iter()
                .find_map(|(step, body)| (*step == 4).then(|| body.clone()))
            {
                break body;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("steward request at step 4");
    assert!(
        directed.to_string().contains(ENTERED),
        "steward did not receive the direction"
    );

    let second = timeout(Duration::from_secs(30), async {
        loop {
            if let Some(second) =
                s.gw.approval_requests("general")
                    .await?
                    .into_iter()
                    .find(|other| {
                        other["approval"]["operation"]["tool"] == "browser_wait_for_user"
                            && other["request_ref"] != card["request_ref"]
                    })
            {
                break Ok::<_, HarnessError>(second);
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("second hand-off card")?;
    snapshot(&admin, tabs("user")).await?;
    let reference = second["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/hand-back?session_id=general"),
            json!({}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    timeout(Duration::from_secs(10), async {
        while given_back_frames() < 2 {
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("Done gives back t1");
    assert_eq!(given_back_frames(), 2);

    snapshot(&admin, tabs("agent")).await?;
    timeout(Duration::from_secs(30), async {
        loop {
            let disposition = requests.lock().unwrap().iter().any(|(step, _)| *step == 5);
            if disposition && s.gw.approval_requests("general").await?.is_empty() {
                break Ok::<_, HarnessError>(());
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("steward resumed after Done")?;
    s.finish().await?;
    server.abort();
    Ok(())
}
