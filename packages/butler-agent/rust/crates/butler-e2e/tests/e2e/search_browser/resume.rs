//! A research turn that stops for approvals keeps what it found: after each
//! resume, result ids name the same pages, and pages the turn found by search
//! are read under ask-first without asking, though the turn read the web.
use super::{host, model};
use axum::{
    Json, Router,
    extract::{Query, State},
    response::Response,
    routing::{get, post},
};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Scenario, Setup},
    security::AdminClient,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

const PROMPT: &str = "Compare the tide tables from both harbours, with sources.";
const UNSEEN: &str = "https://example.net/tides?harbour=unseen";

/// The pages a search for `alpha` or `beta` finds. Each URL has a query, so
/// it would ask after web content unless the turn found it itself.
fn page(name: &str, n: u8) -> String {
    format!("https://example.com/tides?harbour={name}-{n}")
}

#[derive(Default)]
struct Script {
    outputs: Mutex<Vec<Value>>,
    files: Mutex<Vec<String>>,
}

#[tokio::test]
async fn result_ids_and_found_pages_survive_approval_resumes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let script = Arc::new(Script::default());
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", socket.local_addr()?);
    let app = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
        .route("/search", get(search))
        .with_state(script.clone());
    let server = tokio::spawn(async move {
        axum::serve(socket, app).await.unwrap();
    });
    let setup = Setup::new("SEARCH-BROWSER-RESUME")?
        .access(Access::AskExceptReads)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{base}/v1"))
        .env("BUTLER_BRAVE_SEARCH_API_KEY", "offline-fixture-key");
    let mut files = Vec::new();
    for name in ["first.txt", "second.txt"] {
        let path = setup.sandbox.home.join(name);
        std::fs::write(&path, "Harbour note")?;
        files.push(path.to_string_lossy().into_owned());
    }
    *script.files.lock().unwrap() = files;
    let s = setup.start().await?;
    s.patch_settings(
        json!({"browser":{"browsing_agent":"off"}}),
        "direct browser tools",
    )
    .await?;
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    config["webSearch"] = json!({"provider":"brave","planning":{"enabled":false},
        "readerBackend":"disabled","braveApiBase":format!("{base}/search")});
    std::fs::write(path, serde_json::to_vec(&config)?)?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let served = tokio::spawn(host::Host::attach(admin).await?.serve());
    let turn = s.gw.say_turn("general", PROMPT).await?;

    // Two outside-file reads suspend the turn; browser calls remain usable on resume.
    let mut seen = HashSet::new();
    for _ in 0..2 {
        let card = next_card(&s, &mut seen).await?;
        assert_eq!(card["approval"]["operation"]["tool"], "read_file", "{card}");
        answer(&s, &card, "allow").await?;
    }
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    served.abort();
    server.abort();
    let outputs = script.outputs.lock().unwrap().clone();
    assert_eq!(outputs.len(), 11, "{outputs:#?}");

    // The same pages keep their ids across both resumes.
    let ids = |output: &Value| {
        output["results"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| (r["id"].clone(), r["url"].clone()))
            .collect::<Vec<_>>()
    };
    let alpha = [("r1", page("alpha", 1)), ("r2", page("alpha", 2))]
        .map(|(id, url)| (json!(id), json!(url)));
    let beta =
        [("r3", page("beta", 1)), ("r4", page("beta", 2))].map(|(id, url)| (json!(id), json!(url)));
    assert_eq!(ids(&outputs[0]), alpha, "{}", outputs[0]);
    assert_eq!(ids(&outputs[1]), beta, "{}", outputs[1]);
    assert_eq!(ids(&outputs[3]), beta, "after resume: {}", outputs[3]);
    for (index, id, url) in [(4, "r1", page("alpha", 1)), (8, "r4", page("beta", 2))] {
        let tab = &outputs[index]["tabs"][0];
        assert_eq!(tab["result"], id, "{}", outputs[index]);
        assert_eq!(tab["status"], "ok", "{}", outputs[index]);
        assert_eq!(
            tab["untrusted_content"]["url"],
            url.as_str(),
            "{}",
            outputs[index]
        );
    }

    // Found pages and an observation remain usable across both resumes.
    for index in [5, 6, 9] {
        let read = &outputs[index];
        assert_eq!(read["status"], "ok", "{read}");
        assert!(read.get("authority_pending").is_none(), "{read}");
        assert!(!read.to_string().contains("authority_request"), "{read}");
    }
    assert!(outputs[10].to_string().contains("tool_unavailable"));
    crate::access_tiers::assert_counts(&s, &turn, 2, 0)?;
    s.finish().await
}

/// The next approval card this turn raises.
async fn next_card(s: &Scenario, seen: &mut HashSet<String>) -> Result<Value, HarnessError> {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        for card in s.gw.approval_requests("general").await? {
            if seen.insert(card["request_ref"].as_str().unwrap_or("").to_owned()) {
                return Ok(card);
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no approval card\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn answer(s: &Scenario, card: &Value, decision: &str) -> Result<(), HarnessError> {
    let reference = card["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/{decision}?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{reply:?}");
    Ok(())
}

async fn search(Query(query): Query<HashMap<String, String>>) -> Json<Value> {
    let q = query.get("q").map_or("", String::as_str);
    let name = if q.contains("beta") { "beta" } else { "alpha" };
    let results = [1, 2].map(|n| {
        json!({"title":format!("Tide table {name} {n}"),"url":page(name, n),
            "description":format!("Published tide table ({name} {n}).")})
    });
    Json(json!({"web":{"results":results}}))
}

async fn reply(State(script): State<Arc<Script>>, Json(body): Json<Value>) -> Response {
    let item = match body["tools"].as_array() {
        Some(tools) if !tools.is_empty() => next(&script, &body),
        _ => model::message("Tide tables"),
    };
    let record = crate::browser_usage::stub::response(&item);
    let model = body["model"].as_str().unwrap_or("gpt-6-luna").to_owned();
    let stream = futures_util::stream::iter(record.chunks).map(move |chunk| {
        Ok::<_, std::io::Error>(bytes::Bytes::from(chunk.text.replace("gpt-6-sol", &model)))
    });
    axum::http::Response::builder()
        .header("content-type", "text/event-stream")
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
}

/// Search twice, stop on a file read, search again, open and read results
/// found before the stop, stop again, then read once more and try an unseen URL.
fn next(script: &Script, body: &Value) -> Value {
    let outputs = model::outputs(body);
    *script.outputs.lock().unwrap() = outputs.clone();
    let files = script.files.lock().unwrap().clone();
    let read_file = |path: &str| json!({"requests":[{"path":path}]});
    let step = outputs.len();
    let (name, args) = match step {
        0 => ("web_search", json!({"query":"alpha harbour tides"})),
        1 | 3 => ("web_search", json!({"query":"beta harbour tides"})),
        2 => ("read_file", read_file(&files[0])),
        4 => ("browser_open", json!({"results":["r1"]})),
        5 => ("browser_open", json!({"url":page("alpha", 2)})),
        6 => ("browser_observe", json!({"tab":outputs[5]["tab"]})),
        7 => ("read_file", read_file(&files[1])),
        8 => ("browser_open", json!({"results":["r4"]})),
        9 => ("browser_open", json!({"url":page("beta", 1)})),
        10 => ("web_read", json!({"url":UNSEEN})),
        _ => return model::message("Both harbours list the same spring tide."),
    };
    model::call(step, name, &args)
}
