//! A Worker reads pages and sends the browsing agent wherever reads are allowed; acting in a page stays with its Steward.
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{
    HarnessError, cassette::Cassette, matching, sanitize::Placeholders, scenario::Setup,
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

type Requests = Arc<Mutex<Vec<(String, Value)>>>;
type Script = (Requests, Arc<Vec<(&'static str, Value)>>);
const DATA_URL: &str = "https://example.com/?q=external-note";

#[tokio::test]
async fn ask_except_reads_worker_reads_tabs_and_never_acts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    run("ask_except_reads", vec![
        ("browse", json!({"goal":"Find the page heading","fields":["heading"],"url":"https://example.com/"})),
        ("browser_read", json!({"url":"https://example.com/"})),
        ("browser_observe", json!({"tab":"worker-tab","look":"never"})),
        ("browser_act", json!({"tab":"worker-tab","observation":"o1","steps":[{"action":"click","ref":"e1","commits":true}]})),
    ]).await
}

#[tokio::test]
async fn ask_first_worker_browser_open_asks_like_web_read() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    run(
        "ask_first",
        vec![
            ("browser_open", json!({"url":"https://example.com/"})),
            ("browser_open", json!({"url":DATA_URL})),
        ],
    )
    .await
}

async fn run(mode: &str, steps: Vec<(&'static str, Value)>) -> Result<(), HarnessError> {
    let requests = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/codex", listener.local_addr()?);
    let app = Router::new()
        .route("/codex/responses", post(reply))
        .with_state((requests.clone(), Arc::new(steps)));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let s = Setup::new("BROWSER-WORKER-READS")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", endpoint)
        .start()
        .await?;
    let controls =
        s.gw.patch("/sessions/general/controls", json!({"access_mode":mode}))
            .await?;
    assert_eq!(controls.status, 200);
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let frames = Arc::new(Mutex::new(Vec::<Value>::new()));
    let recorded = frames.clone();
    let host = tokio::spawn(async move {
        let mut buffer = String::new();
        loop {
            let frame = match super::next_frame(&mut stream, &mut buffer).await {
                Ok(frame) => frame,
                Err(error) => return Err::<(), HarnessError>(error),
            };
            recorded.lock().unwrap().push(frame.clone());
            let op = frame["op"].as_str().unwrap();
            if op.starts_with("use.") {
                continue;
            }
            let result = match op {
                "tab.open" => {
                    admin.send(Method::POST, "/internal/browser-host/events", Some(json!({"tabs":[{"id":"worker-tab","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","url":"https://example.com/"}]})), &[]).await?;
                    json!({"status":"ok","tab":"worker-tab","url":"https://example.com/"})
                }
                "tab.read" => {
                    json!({"status":"ok","tab":"worker-tab","url":"https://example.com/","epoch":1,"html":"<html><title>Example</title><article><h1>Example page</h1><p>Published page text.</p></article></html>"})
                }
                "tab.observe" => {
                    json!({"status":"ok","tab":"worker-tab","obs":"o1","url":"https://example.com/","text":"Example page"})
                }
                _ => json!({"status":"ok"}),
            };
            admin
                .send(
                    Method::POST,
                    &format!(
                        "/internal/browser-host/{}/{}",
                        if op == "tab.read" {
                            "renders"
                        } else {
                            "results"
                        },
                        frame["id"].as_str().unwrap()
                    ),
                    Some(result),
                    &[],
                )
                .await?;
        }
    });
    let turn =
        s.gw.say_turn("general", "Read https://example.com/ for me.")
            .await?;
    let mut denied = Vec::new();
    if mode == "ask_first" {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while denied.is_empty() && tokio::time::Instant::now() < deadline {
            for card in s.gw.approval_requests("general").await? {
                let action = if card["approval"]["operation"]["targets"][0] == DATA_URL {
                    denied.push(card.clone());
                    "deny"
                } else {
                    "allow"
                };
                let reference = card["request_ref"].as_str().unwrap();
                let reply =
                    s.gw.post(
                        &format!("/authority-requests/{reference}/{action}?session_id=general"),
                        json!({"scope":"once"}),
                    )
                    .await?;
                assert_eq!(reply.status, 202, "{reply:?}");
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    let terminal =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(butler_e2e::e2e::gateway::turn_state(&terminal), "delivered");
    if mode == "ask_first" {
        assert_eq!(denied.len(), 1, "one DATA_URL card: {denied:?}");
        assert_eq!(denied[0]["approval"]["operation"]["tool"], "browser_open");
        let frames = frames.lock().unwrap();
        let opens: Vec<_> = frames
            .iter()
            .filter(|frame| frame["op"] == "tab.open")
            .collect();
        assert_eq!(opens.len(), 1);
        assert_eq!(opens[0]["args"]["url"], "https://example.com/");
    } else {
        let finished = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                {
                    let frames = frames.lock().unwrap();
                    if let Some(open) = frames.iter().find(|frame| frame["op"] == "tab.open")
                        && frames.iter().any(|frame| {
                            frame["op"] == "use.finished" && frame["turn_id"] == open["turn_id"]
                        })
                    {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        {
            let requests = requests.lock().unwrap();
            let workers: Vec<_> = requests
                .iter()
                .filter(|(role, _)| role == "worker")
                .collect();
            assert!(!workers.is_empty(), "at least one worker request");
            for (_, body) in &workers {
                let names: Vec<_> = body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|tool| tool["tools"].as_array().into_iter().flatten())
                    .filter_map(|tool| tool["name"].as_str())
                    .collect();
                assert!(
                    names.contains(&"browse")
                        && names.contains(&"browser_read")
                        && !names.contains(&"browser_act")
                        && !names.contains(&"browser_open"),
                    "worker browser surface: {names:?}"
                );
            }
            let browse: Vec<_> = requests
                .iter()
                .filter(|(role, _)| role == "browse")
                .collect();
            assert_eq!(browse.len(), 1);
            assert!(
                browse[0].1["input"]
                    .to_string()
                    .contains(r#"\"page_actions\":\"unavailable\""#)
            );
            assert!(
                workers[0].1["input"]
                    .to_string()
                    .contains("Choose the page reader by what you need.")
            );
            let output = workers.last().unwrap().1["input"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| {
                    item["type"] == "function_call_output" && item["call_id"] == "read-worker-2"
                })
                .unwrap();
            let output: Value = serde_json::from_str(output["output"].as_str().unwrap()).unwrap();
            let output = &output["output"];
            assert_eq!(output["status"], "done");
            assert_eq!(output["fields"]["heading"], "Example page");
            assert_eq!(output["evidence"][0]["url"], "https://example.com/");
        }
        finished.unwrap();
        {
            let frames = frames.lock().unwrap();
            let ops: Vec<_> = frames
                .iter()
                .filter_map(|frame| frame["op"].as_str())
                .collect();
            assert!(
                ops.contains(&"tab.open")
                    && ops.contains(&"tab.observe")
                    && !ops.contains(&"tab.act")
            );
            for frame in frames
                .iter()
                .filter(|frame| frame["op"].as_str().unwrap().starts_with("tab."))
            {
                assert_eq!(frame["session"], "general");
            }
            let open = frames
                .iter()
                .find(|frame| frame["op"] == "tab.open")
                .unwrap();
            let finished = frames
                .iter()
                .find(|frame| frame["op"] == "use.finished" && frame["turn_id"] == open["turn_id"])
                .unwrap();
            assert_eq!(finished["args"]["close_read_tabs"], true);
        }
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let session: String = db.query_row("SELECT t.session_id FROM btcc_guided_tool_calls c JOIN btcc_turns t ON t.turn_id=c.turn_id WHERE c.tool_name='browser_read'", [], |row| row.get(0))?;
        assert_ne!(session, "general");
        let mode: String = db.query_row("SELECT json_extract(context_json,'$.executionPolicy.accessMode') FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1", [&session], |row| row.get(0))?;
        assert_eq!(mode, "ask_except_reads");
        drop(db);
    }
    s.finish().await?;
    host.abort();
    server.abort();
    Ok(())
}

async fn reply(
    State((requests, steps)): State<Script>,
    Json(body): Json<Value>,
) -> impl axum::response::IntoResponse {
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    let step = key
        .round
        .iter()
        .filter(|k| k.as_str() == "function_call_output")
        .count();
    if body["instructions"]
        .as_str()
        .unwrap_or("")
        .starts_with("You operate one browser tab for a planner")
    {
        requests
            .lock()
            .unwrap()
            .push(("browse".into(), body.clone()));
        let item = json!({"type":"message","id":"browse-done","role":"assistant","status":"completed","content":[{"type":"output_text","text":r#"{"notes":"","next":{"done":{"fields":{"heading":"Example page"},"evidence":[{"field":"heading","quote":"Example page"}],"summary":"Heading found."}}}"#,"annotations":[]}]});
        let response = crate::browser_usage::stub::response(&item);
        return (
            [("content-type", "text/event-stream")],
            response
                .chunks
                .into_iter()
                .map(|c| c.text)
                .collect::<String>(),
        );
    }
    let worker = key.user_request.starts_with("role: worker");
    let steward = key.user_request.starts_with("role: steward")
        || body["instructions"]
            .as_str()
            .unwrap_or("")
            .contains("You run one delegated Work for Butler");
    let role = if worker {
        "worker"
    } else if steward {
        "steward"
    } else {
        "parent"
    };
    requests
        .lock()
        .unwrap()
        .push((role.to_owned(), body.clone()));
    let call = if worker {
        let mut script = vec![
            (
                "replace_work_plan",
                json!({"objective":"Read the page","execution_mode":"direct","actions":[{"action_key":"read","description":"Read the page","dependency_keys":[]}],"checks":["Page read"]}),
            ),
            (
                "record_work_review",
                json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
            ),
        ];
        script.extend(steps.iter().cloned());
        script.push(("record_work_disposition", json!({"work_id":crate::steward_presentation::stub::work_id(&body),"disposition":"completed","summary":"Page read","action_updates":[{"action_key":"read","status":"done"}],"remaining_actions":[],"followups":[]})));
        script.get(step).cloned()
    } else if steward && !key.user_request.starts_with("Delegated result") {
        match step {
            0 => Some((
                "replace_work_plan",
                json!({"objective":"Read the page","execution_mode":"workers","actions":[{"action_key":"read","description":"Read the page","dependency_keys":[]}],"checks":["Page read"]}),
            )),
            1 => Some((
                "record_work_review",
                json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
            )),
            2 => Some((
                "delegate_to_worker",
                json!({"task":{"scope":{"paths":["tasks/read"]},"output":{"format":"text","fields":["summary"]}},"action_key":"read","objective":"Read the page","acceptance_criteria":["Page read"],"implementation_brief":"Read the page","safe_title":"Read the page"}),
            )),
            3 => Some(("wait_for_worker", json!({}))),
            4 => Some((
                "record_work_disposition",
                json!({"work_id":crate::steward_presentation::stub::work_id(&body),"disposition":"completed","summary":"Page read","action_updates":[{"action_key":"read","status":"done"}],"remaining_actions":[],"followups":[]}),
            )),
            _ => None,
        }
    } else if !steward && step == 0 && !key.user_request.starts_with("Delegated result") {
        Some((
            "delegate_to_steward",
            json!({"request":"Read the page","checks":["Page read"],"safe_title":"Read page"}),
        ))
    } else {
        None
    };
    let id = format!("read-{role}-{step}");
    let item = match call {
        Some((name, args)) => {
            json!({"type":"function_call","id":id,"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"})
        }
        None => {
            json!({"type":"message","id":id,"role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]})
        }
    };
    let response = crate::browser_usage::stub::response(&item);
    (
        [("content-type", "text/event-stream")],
        response
            .chunks
            .into_iter()
            .map(|c| c.text)
            .collect::<String>(),
    )
}
