//! A Steward result turn that calls wait_for_worker while another Worker's
//! result is queued behind it must wait. Lives under worker_cap to reuse its
//! stub provider.
use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{matching, sanitize::Placeholders};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::watch;

struct Proxy {
    upstream: String,
    client: reqwest::Client,
    armed: AtomicBool,
    held: watch::Sender<bool>,
    release: watch::Sender<bool>,
}

/// Forwards to the worker_cap stub; holds the first Steward "Delegated result"
/// round 0 until the test releases it.
async fn forward(State(p): State<Arc<Proxy>>, Json(body): Json<Value>) -> impl IntoResponse {
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    let steward = key.user_request.starts_with("role: steward")
        || body["instructions"]
            .as_str()
            .unwrap_or("")
            .contains("You run one delegated Work for Butler");
    let step = key
        .round
        .iter()
        .filter(|kind| kind.as_str() == "function_call_output")
        .count();
    let result_turn = steward && key.user_request.starts_with("Delegated result") && step == 0;
    if result_turn && p.armed.swap(false, Ordering::SeqCst) {
        eprintln!("[RESULT-TURNS] holding Steward result turn round 0");
        p.held.send_replace(true);
        let mut release = p.release.subscribe();
        while !*release.borrow_and_update() {
            release.changed().await.unwrap();
        }
        eprintln!("[RESULT-TURNS] released Steward result turn round 0");
    }
    let text = p
        .client
        .post(&p.upstream)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    ([("content-type", "text/event-stream")], text).into_response()
}

async fn until(s: &Scenario, sql: &str, session: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        if db
            .query_row(sql, [session], |row| row.get::<_, Option<bool>>(0))?
            .unwrap_or(false)
        {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "{sql}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn waits(s: &Scenario) -> Result<Vec<(String, String)>, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let mut statement = db.prepare(
        "SELECT turn_id, COALESCE(result_json,'') FROM btcc_guided_tool_calls
         WHERE tool_name='wait_for_worker' ORDER BY rowid",
    )?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tokio::test]
async fn result_turn_waits_while_other_result_is_queued() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (upstream, script, server) = stub::start(2).await?;
    script.wait_regression.store(true, Ordering::SeqCst);
    let proxy = Arc::new(Proxy {
        upstream: format!("{upstream}/responses"),
        client: reqwest::Client::new(),
        armed: AtomicBool::new(false),
        held: watch::channel(false).0,
        release: watch::channel(false).0,
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let app = Router::new()
        .route("/codex/responses", post(forward))
        .with_state(proxy.clone());
    let proxy_task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let s = Setup::new("RESULT-TURNS")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", url)
        .start()
        .await?;
    s.gw.say("general", "Verify batch red").await?;
    let (steward, rows) = workers(&s, "general", 2).await?;
    started(&script, 2).await;
    // The Steward's first turn waits for both Workers.
    until(&s, "SELECT (SELECT suspension_reason='waiting_for_worker' FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1)", &steward).await?;
    proxy.armed.store(true, Ordering::SeqCst);
    script.release("red-0");
    closed(&s, rows[0]["session_id"].as_str().unwrap()).await?;
    // Worker A's result turn is running (held in its first model round).
    let mut held = proxy.held.subscribe();
    tokio::time::timeout(Duration::from_secs(30), async {
        while !*held.borrow_and_update() {
            held.changed().await.unwrap();
        }
    })
    .await
    .expect("Steward result turn never reached the provider");
    // Worker B finishes; its result is committed and queued behind the running turn.
    script.release("red-1");
    closed(&s, rows[1]["session_id"].as_str().unwrap()).await?;
    let queued_turns: i64 = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?
        .query_row("SELECT count(*) FROM btcc_steward_results x JOIN btcc_session_relations r ON r.relation_id=x.relation_id WHERE r.parent_session_id=?1", [&steward], |r| r.get(0))?;
    eprintln!("[RESULT-TURNS] worker results committed for steward: {queued_turns}");
    proxy.release.send_replace(true);
    let deadline = Instant::now() + Duration::from_secs(30);
    let calls = loop {
        let calls = waits(&s)?;
        if calls.len() >= 2 && !calls[1].1.is_empty() {
            break calls;
        }
        assert!(
            Instant::now() < deadline,
            "second wait_for_worker missing: {calls:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    for (i, (turn, result)) in calls.iter().enumerate() {
        eprintln!("[RESULT-TURNS] wait_for_worker #{i} turn={turn} result={result}");
    }
    assert!(
        calls[1].1.contains("\"waiting\""),
        "Worker-result turn's wait_for_worker answered without waiting for the queued result: {}",
        calls[1].1
    );
    s.finish().await?;
    server.abort();
    proxy_task.abort();
    Ok(())
}
