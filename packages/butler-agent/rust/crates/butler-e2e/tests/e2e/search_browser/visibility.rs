//! Each browser result tells the model what the user sees of the tab, and a
//! local address names where such pages open instead.
use super::{host, model};
use axum::{Json, Router, extract::State, response::Response, routing::post};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Access, Setup},
    security::AdminClient,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
struct Script {
    /// Each tool output the model received, in order.
    outputs: Mutex<Vec<Value>>,
    /// The tab the user is looking at; shared with the host.
    viewed: Arc<Mutex<Option<String>>>,
}

#[tokio::test]
async fn browser_results_say_what_the_user_sees() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", socket.local_addr()?);
    let script = Arc::new(Script::default());
    let app = Router::new()
        .route("/v1/responses", post(respond))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
        .with_state(script.clone());
    let server = tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
    let s = Setup::new("BROWSER-VISIBILITY")?
        .access(Access::FullAccess)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{base}/v1"))
        .start()
        .await?;
    s.patch_settings(json!({"browser":{"browsing_agent":"off"}}), "direct browser tools")
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = host::Host::attach(admin).await?;
    host.viewed = script.viewed.clone();
    let log = host.log.clone();
    let served = tokio::spawn(host.serve());
    let turn = s
        .gw
        .say_turn("general", "Open the alpha tide table, then my local dev page")
        .await?;
    let done = s
        .gw
        .wait_terminal("general", &turn, Duration::from_secs(60))
        .await?;
    served.abort();
    server.abort();
    assert_eq!(butler_e2e::e2e::gateway::turn_state(&done), "delivered", "{done}");
    let outputs = script.outputs.lock().unwrap().clone();
    assert_eq!(outputs[0]["status"], "ok", "{}", outputs[0]);
    assert_eq!(outputs[0]["seen_by_user"], "in_pane", "{}", outputs[0]);
    assert_eq!(outputs[1]["seen_by_user"], "showing", "{}", outputs[1]);
    assert_eq!(outputs[2]["reason"], "navigation_denied", "{}", outputs[2]);
    let recovery = outputs[2]["recovery"].as_str().unwrap();
    assert!(recovery.contains("preview_start") && recovery.contains("deliver_files"), "{recovery}");
    let opens = log
        .lock()
        .unwrap()
        .iter()
        .filter(|frame| frame["op"] == "tab.open")
        .count();
    assert_eq!(opens, 1, "the local address never reaches the browser");
    s.finish().await
}

async fn respond(State(script): State<Arc<Script>>, Json(body): Json<Value>) -> Response {
    let tooled = butler_e2e::e2e::chatgpt_wire::functions(&body)
        .next()
        .is_some();
    let item = if tooled {
        let outputs = model::outputs(&body);
        *script.outputs.lock().unwrap() = outputs.clone();
        step(&script, &outputs)
    } else {
        model::message("Tide tables")
    };
    let wire = crate::steward_presentation::stub::wire_items(&[item]);
    let name = body["model"].as_str().unwrap_or("gpt-6-luna").to_owned();
    let stream = futures_util::stream::iter([wire]).map(move |wire| {
        Ok::<_, std::io::Error>(bytes::Bytes::from(wire.replace("gpt-6-luna", &name)))
    });
    axum::http::Response::builder()
        .header("content-type", "text/event-stream")
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
}

/// Open a page (the pane is closed), look at it after the user opened it, then try a local address.
fn step(script: &Script, outputs: &[Value]) -> Value {
    match outputs.len() {
        0 => model::call(0, "browser_open", &json!({"url":"https://example.com/tides/alpha"})),
        1 => {
            *script.viewed.lock().unwrap() = outputs[0]["tab"].as_str().map(str::to_owned);
            model::call(1, "browser_observe", &json!({"tab":outputs[0]["tab"]}))
        }
        2 => model::call(2, "browser_open", &json!({"url":"http://localhost/"})),
        _ => model::message("The tide table is open in the pane; the local page opens with preview_start."),
    }
}
