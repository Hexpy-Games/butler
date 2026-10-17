//! A model-written Plan with declared dependencies reaches the inspector graph
//! as ranked columns, and the model sees how to declare them.
use crate::steward_presentation::{
    setup,
    stub::{call, message, wire},
};
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const OWNER: &str = "Research three sources, compare them, and send me a short report.";
const GATHER: [&str; 3] = [
    "Gather findings from the first source",
    "Gather findings from the second source",
    "Gather findings from the third source",
];
const COMPARE: &str = "Compare the findings from all three sources";
const REPORT: &str = "Deliver a short report of the comparison";

#[derive(Default)]
struct Script {
    step: Mutex<usize>,
    requests: Mutex<Vec<Value>>,
}

fn plan() -> Value {
    let mut actions: Vec<Value> = GATHER
        .iter()
        .map(|key| json!({"action_key":key,"dependency_keys":[]}))
        .collect();
    actions.push(json!({"action_key":COMPARE,"dependency_keys":GATHER}));
    actions.push(json!({"action_key":REPORT,"dependency_keys":[COMPARE]}));
    json!({"start_new":false,"objective":OWNER,"execution_mode":"direct","governing_refs":[],
        "actions":actions,"checks":["Report covers all three sources"]})
}

async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> impl axum::response::IntoResponse {
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    let item = if key.user_request == OWNER {
        script.requests.lock().unwrap().push(body.clone());
        let mut step = script.step.lock().unwrap();
        *step += 1;
        match *step {
            1 => call("start", "start_work", &json!({"objective":OWNER})),
            2 => call("plan", "replace_work_plan", &plan()),
            3 => call(
                "review",
                "record_work_review",
                &json!({"subject":"plan","verdict":"accept","summary":"Ready","corrections":[],"action_updates":[]}),
            ),
            _ => message("Plan ready."),
        }
    } else {
        message("{}")
    };
    ([("content-type", "text/event-stream")], wire(item))
}

#[tokio::test]
async fn task_graph_ranks_declared_plan_dependencies_as_columns() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script::default());
    let router = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(script.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let s = setup("TASK-GRAPH-DECLARED", &url)?.start().await?;
    let (_, turn) = s.turn("general", OWNER).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert_dependency_schema(&script.requests.lock().unwrap()[0]);
    let list = s.gw.get("/sessions/general/task-graphs").await?;
    assert_eq!(list.status, 200, "{}", list.text);
    let id = list.data()["graphs"][0]["graph_id"].as_str().unwrap();
    let graph = s.gw.get(&format!("/plans/{id}/task-graph")).await?;
    assert_eq!(graph.status, 200, "{}", graph.text);
    assert_ranked(graph.data());
    server.abort();
    s.finish().await
}

fn assert_ranked(graph: &Value) {
    let nodes = graph["nodes"].as_array().unwrap();
    let titles: Vec<_> = nodes.iter().map(|n| n["title"].as_str().unwrap()).collect();
    assert_eq!(
        titles,
        [GATHER[0], GATHER[1], GATHER[2], COMPARE, REPORT],
        "{graph}"
    );
    let ranks: Vec<_> = nodes.iter().map(|n| n["rank"].as_u64().unwrap()).collect();
    assert_eq!(ranks, [0, 0, 0, 1, 2], "{graph}");
    let id = |i: usize| nodes[i]["task_id"].clone();
    let mut edges: Vec<_> = graph["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["from"].clone(), e["to"].clone()))
        .collect();
    edges.sort_by_key(|(from, to)| (from.to_string(), to.to_string()));
    let mut expected = vec![
        (id(0), id(3)),
        (id(1), id(3)),
        (id(2), id(3)),
        (id(3), id(4)),
    ];
    expected.sort_by_key(|(from, to)| (from.to_string(), to.to_string()));
    assert_eq!(edges, expected, "{graph}");
    assert_eq!(graph["totals"]["nodes"], 5, "{graph}");
}

fn assert_dependency_schema(request: &Value) {
    let tool = request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "replace_work_plan")
        .expect("replace_work_plan offered");
    let description = tool
        .pointer("/parameters/properties/actions/items/properties/dependency_keys/description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(!description.trim().is_empty(), "{tool}");
}
