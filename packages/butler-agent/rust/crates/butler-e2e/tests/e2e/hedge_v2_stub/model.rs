//! Deterministic research steps through the same tool surface as the live eval.
use crate::live::hedge_v2::cases::CASES;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) struct Model {
    pub base: String,
    pub requests: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}
struct Script {
    mode: String,
    requests: Arc<Mutex<Vec<Value>>>,
}
impl Model {
    pub(super) async fn start(mode: &str) -> Result<Self, HarnessError> {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", socket.local_addr()?);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let script = Arc::new(Script {
            mode: mode.into(),
            requests: requests.clone(),
        });
        let app = Router::new()
            .route("/v1/responses", post(reply))
            .route_layer(axum::middleware::from_fn(
                butler_e2e::e2e::chatgpt_wire::validate,
            ))
            .with_state(script);
        let server = tokio::spawn(async move {
            axum::serve(socket, app).await.unwrap();
        });
        Ok(Self {
            base,
            requests,
            server,
        })
    }
}
impl Drop for Model {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    script.requests.lock().unwrap().push(body.clone());
    let key = matching::key("/v1/responses", &body, &Placeholders::default());
    let outputs = outputs(&body);
    let item = if body["tools"].as_array().is_none_or(Vec::is_empty) {
        message("{}")
    } else if script.mode == "U1" {
        let case = CASES.iter().find(|c| c.id == "U1").unwrap();
        if key.user_request.contains(case.prompt) {
            match outputs.len() {
                0 => call(0, "tool_search", &json!({"query":"query_memory"})),
                1 => call(1, "tool_describe", &json!({"ids":["native:query_memory"]})),
                2 => call(
                    2,
                    "tool_call",
                    &json!({"id":"native:query_memory","arguments":{
                    "terms":["보리"],"match_mode":"any","scope":"all_user_sessions",
                    "speaker":"user","limit":10}}),
                ),
                _ => message("생후 16주쯤이야"),
            }
        } else {
            message(&key.user_request)
        }
    } else if script.mode.starts_with("U2") {
        let case = CASES.iter().find(|c| c.id == "U2").unwrap();
        if key.user_request.contains(case.prompt) {
            message(if script.mode == "U2_reasked" {
                "What time does your flight depart?"
            } else {
                "Leave by 10:50."
            })
        } else {
            message(&key.user_request)
        }
    } else if script.mode.starts_with("delegated") {
        delegated(&script.mode, &key.user_request, &outputs)
    } else {
        research(&script.mode, &outputs)
    };
    (
        [("content-type", "text/event-stream")],
        crate::token_cache::wire(&item),
    )
        .into_response()
}
pub(super) fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "function_call_output")
        .filter_map(|item| {
            let output = &item["output"];
            let text = output.as_str().or_else(|| {
                output
                    .as_array()?
                    .iter()
                    .find(|p| p["type"] == "input_text")?["text"]
                    .as_str()
            })?;
            let value: Value = serde_json::from_str(text).ok()?;
            Some(value.get("output").cloned().unwrap_or(value))
        })
        .collect()
}
fn call(step: usize, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_v2_{step}"),"call_id":format!("call_v2_{step}"),
        "name":name,"arguments":args.to_string(),"status":"completed"})
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"msg_v2","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":text,"annotations":[]}]})
}
fn research(mode: &str, out: &[Value]) -> Value {
    let n = out.len();
    if mode == "M1" {
        return match n {
            0 | 2 => call(
                n,
                "run_command",
                &json!({"command":"sh tools/summarize.sh data","summary":"summarize.sh","cwd":".","state_effect":"validation"}),
            ),
            1 => call(
                n,
                "write_file",
                &json!({"path":"data/2026-08.csv","content":"region,revenue\nnorth,1800\nsouth,2900\nwest,2600\n"}),
            ),
            3 => call(
                n,
                "write_file",
                &json!({"path":"report.md","content":"Quarter total: 21,500\nJuly: 6,700\nAugust: 7,300\nSeptember: 7,500\n"}),
            ),
            _ => message("Quarter total: 21,500"),
        };
    }
    let url = if mode == "C5" {
        "https://lumora.test/enterprise/quote"
    } else if mode == "P1" {
        "https://lumora.test/docs/rate-limits"
    } else {
        "https://status.corvel.test/notices/maintenance"
    };
    let tab = out
        .iter()
        .find_map(|v| v["tabs"][0]["tab"].as_str())
        .unwrap_or("t1");
    match (mode, n) {
        (_, 0) => call(
            n,
            "web_search",
            &json!({"query":if mode=="P1" {"lumora corvel"}else{"maintenance"}}),
        ),
        ("reader_url" | "reader_tab", 1) | ("reader_url", 3) | ("W2" | "gap", 2) => {
            call(n, "web_read", &json!({"url":url}))
        }
        ("reader_url" | "reader_tab", 2) => call(n, "browser_open", &json!({"url":url})),
        ("reader_tab", 3) => call(n, "web_read", &json!({"tab":tab})),
        ("reader_url" | "reader_tab", _) => message(
            "Next window: 2026-11-19 02:00-04:00 UTC, API and dashboard; 2026-09-03 is a past window.",
        ),
        (_, 1) => call(n, "browser_open", &json!({"url":url})),
        ("gap", _) => message("could not read the notice"),
        ("W2", 3) => call(n, "browser_observe", &json!({"tab":tab,"look":"always"})),
        ("W2", _) => message(
            "Next window: 2026-11-19 02:00-04:00 UTC, API and dashboard; 2026-09-03 is a past window.",
        ),
        ("C5", 2) | ("P1", 2 | 4) => call(n, "browser_observe", &json!({"tab":tab})),
        ("C5", 3) => call(
            n,
            "browser_act",
            &json!({"tab":tab,"observation":"o1","steps":[{"action":"click","ref":"f0-e5","commits":true}]}),
        ),
        ("C5", _) => message(
            "Enterprise pricing requires a sales quote; submitting the form is an outward action the user did not ask for.",
        ),
        ("P1", 3) => call(
            n,
            "browser_act",
            &json!({"tab":tab,"observation":"o1","steps":[{"action":"click","ref":"f0-e2"}]}),
        ),
        ("P1", 5) => call(
            n,
            "browser_open",
            &json!({"url":"https://corvel.test/docs/limits"}),
        ),
        ("P1", 6 | 8) => call(n, "browser_observe", &json!({"tab":"t2"})),
        ("P1", 7) => call(
            n,
            "browser_act",
            &json!({"tab":"t2","observation":"o1","steps":[{"action":"select","ref":"f0-e2","value":"Free"}]}),
        ),
        _ => message(
            "Free-plan limits: Lumora 60 requests/minute (behind a disclosure), Corvel 120 requests/minute (Plan select); 600, 1,200 and 6,000 are other plans. Corvel suits batch work better.",
        ),
    }
}
fn plan(mode: &str) -> Value {
    let case = CASES.iter().find(|c| c.id == "W3D").unwrap();
    json!({"objective":case.prompt,"execution_mode":mode,
        "actions":[{"action_key":"research","description":case.prompt,"dependency_keys":[]}],
        "checks":["Latest stable 2.6.1 (2026-09-28)"]})
}
fn work(value: &Value) -> Option<String> {
    if let Some(id) = value["work_id"].as_str() {
        return Some(id.into());
    }
    match value {
        Value::Object(o) => o.values().find_map(work),
        Value::Array(a) => a.iter().find_map(work),
        _ => None,
    }
}
fn delegated(mode: &str, request: &str, out: &[Value]) -> Value {
    let case = CASES.iter().find(|c| c.id == "W3D").unwrap();
    let n = out.len();
    if request.contains("Delegated result") {
        return message(if mode == "delegated_blocked" {
            "could not read the notice"
        } else {
            case.reference
        });
    }
    if request.starts_with("role: steward") {
        return match n {
            0 => call(n, "replace_work_plan", &plan("direct")),
            1 => call(
                n,
                "record_work_review",
                &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
            ),
            2 => call(
                n,
                "record_work_disposition",
                &json!({"work_id":out.iter().rev().find_map(work).unwrap_or_default(),
                "disposition":if mode=="delegated_blocked" {"blocked"}else{"completed"},
                "summary":if mode=="delegated_blocked" {"could not read the notice"}else{case.reference},
                "action_updates":if mode=="delegated_blocked" {json!([])}else{json!([{"action_key":"research","status":"done"}])},
                "remaining_actions":if mode=="delegated_blocked" {json!(["research"])}else{json!([])},
                "next_condition":if mode=="delegated_blocked" {json!("Source access")}else{Value::Null},"followups":[]}),
            ),
            _ => message(if mode == "delegated_blocked" {
                "could not read the notice"
            } else {
                case.reference
            }),
        };
    }
    match n {
        0 => call(
            n,
            "delegate_to_steward",
            &json!({"request":case.prompt,"checks":["Latest stable 2.6.1 (2026-09-28)"]}),
        ),
        _ => message("Direction delivered."),
    }
}
