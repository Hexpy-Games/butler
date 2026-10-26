//! A scripted parent and steward, and an offline search provider. The steward
//! researches three search results either one read per round or with its
//! independent reads batched, as its instructions ask.
use super::super::steward_presentation::stub::{
    call, child_lane, message, review, wire_items, work_id,
};
use axum::{
    Json, Router,
    extract::State,
    response::IntoResponse,
    routing::{get, post},
};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) const REQUEST: &str =
    "Research what published tide tables say about spring tides and compare the sources.";
pub(super) const REPORT: &str = "All three tables list the highest spring tide at 6.1 m.";
pub(super) const ANSWER: &str = "The three published tables agree on 6.1 m.";

pub(super) struct Script {
    pub(super) batched: bool,
    rounds: Mutex<(usize, usize)>,
    /// Each model request with whether it came from the steward lane, and the
    /// reply items it was answered with.
    pub(super) exchanges: Mutex<Vec<(bool, Value, Vec<Value>)>>,
}

pub(super) async fn start(
    batched: bool,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let script = Arc::new(Script {
        batched,
        rounds: Mutex::default(),
        exchanges: Mutex::default(),
    });
    let router = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
        .route("/search", get(search))
        .with_state(script.clone());
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((base, script, handle))
}

async fn search() -> Json<Value> {
    let results = ["alpha", "beta", "gamma"].map(|name| {
        json!({"title":format!("Tide table {name}"),"url":format!("https://example.com/tides/{name}"),
            "description":format!("Published spring tide table ({name}).")})
    });
    Json(json!({"web":{"results":results}}))
}

async fn reply(State(script): State<Arc<Script>>, Json(body): Json<Value>) -> impl IntoResponse {
    let child = child_lane(&body);
    let request = matching::key("/v1/responses", &body, &Placeholders::default()).user_request;
    let items = if child {
        let round = next_round(&script, true);
        steward(round, &body, script.batched)
    } else if request == REQUEST {
        vec![parent(next_round(&script, false))]
    } else if request.contains("Delegated result") {
        vec![message(ANSWER)]
    } else {
        vec![message("{}")]
    };
    script
        .exchanges
        .lock()
        .unwrap()
        .push((child, body, items.clone()));
    ([("content-type", "text/event-stream")], wire_items(&items))
}

fn next_round(script: &Script, child: bool) -> usize {
    let mut rounds = script.rounds.lock().unwrap();
    let round = if child { &mut rounds.1 } else { &mut rounds.0 };
    *round += 1;
    *round - 1
}

fn plan(mode: &str) -> Value {
    json!({"start_new":false,"objective":REQUEST,"execution_mode":mode,"governing_refs":[],
        "intent":{"goal":"Know the spring tide height","deliver":"A sourced comparison","next":"Plan around the tide","assume":"Published tables are current"},
        "actions":[{"action_key":"read","description":"Read the published tables","dependency_keys":[]},
            {"action_key":"compare","description":"Compare the tables","dependency_keys":["read"]}],
        "checks":["Every source read in full"]})
}

fn parent(round: usize) -> Value {
    match round {
        0 => call(
            "delegate",
            "delegate_to_steward",
            &json!({"request":REQUEST,"checks":["Every source read in full","Goal: Know the spring tide height","Deliver: A sourced comparison","Next: Plan around the tide","Assumed: Published tables are current"]}),
        ),
        _ => message("The research is under way."),
    }
}

/// The steward's research. Serially every read is its own round; batched,
/// the first reads of all three tabs share one round and their
/// continuations the next. The calls and their arguments are the same.
fn steward(round: usize, body: &Value, batched: bool) -> Vec<Value> {
    let outputs = outputs(body);
    let tabs = || {
        outputs
            .iter()
            .find(|output| output["tabs"].is_array())
            .map(|opened| opened["tabs"].as_array().unwrap().clone())
            .unwrap_or_default()
    };
    let read = |index: usize| {
        let tab = tabs()[index]["tab"].clone();
        call(&format!("read-{index}"), "web_read", &json!({"tab":tab}))
    };
    let rest = |index: usize| {
        let (tab, url) = (
            tabs()[index]["tab"].clone(),
            &tabs()[index]["untrusted_content"]["url"],
        );
        let first = outputs
            .iter()
            .find(|output| output["source_url"] == *url && output["start_chunk"] == 0)
            .unwrap_or_else(|| panic!("first read of {url}: {outputs:?}"));
        call(
            &format!("rest-{index}"),
            "web_read",
            &json!({"tab":tab,"start_chunk":first["next_start_chunk"],"max_chunks":8,"max_chars":8000}),
        )
    };
    let research = 2;
    let reads = if batched { 2 } else { 6 };
    match round {
        0 => vec![call("child-plan", "replace_work_plan", &plan("direct"))],
        1 => vec![call("child-review", "record_work_review", &review())],
        2 => vec![call(
            "search",
            "web_search",
            &json!({"query":"spring tide tables"}),
        )],
        3 => {
            let ids = outputs[outputs.len() - 1]["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|result| result["id"].clone())
                .collect::<Vec<_>>();
            vec![call("open", "browser_open", &json!({"results":ids}))]
        }
        n if n < research + 2 + reads => {
            let step = n - research - 2;
            if batched {
                (0..3)
                    .map(|index| if step == 0 { read(index) } else { rest(index) })
                    .collect()
            } else if step % 2 == 0 {
                vec![read(step / 2)]
            } else {
                vec![rest(step / 2)]
            }
        }
        n if n == research + 2 + reads => vec![call(
            "close",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"completed","summary":REPORT,
                "action_updates":[{"action_key":"read","status":"done"},{"action_key":"compare","status":"done"}],
                "remaining_actions":[],"followups":[]}),
        )],
        _ => vec![message(REPORT)],
    }
}

/// Every function output in the request, decoded, in transcript order.
pub(super) fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "function_call_output")
        .filter_map(|item| {
            let text = item["output"].as_str().or_else(|| {
                item["output"]
                    .as_array()?
                    .iter()
                    .find(|part| part["type"] == "input_text")?["text"]
                    .as_str()
            })?;
            let value: Value = serde_json::from_str(text).ok()?;
            Some(value.get("output").cloned().unwrap_or(value))
        })
        .collect()
}
