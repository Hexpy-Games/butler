//! Scripted provider: Butler's calls per request, and one direct Steward.
use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{matching, sanitize::Placeholders};
use std::sync::{Arc, Mutex};

/// The Steward's report: proposed canon changes for Butler to apply.
pub(super) const REPORT: &str =
    "제안하는 과제 변경: epic.create 「오프라인 모드」, epic.create 「데이터 내보내기」";

#[derive(Default)]
pub(super) struct Script {
    pub(super) requests: Mutex<Vec<Value>>,
    pub(super) project: Mutex<String>,
}

pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/v1", listener.local_addr()?);
    let script = Arc::new(Script::default());
    let app = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
        .with_state(script.clone());
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((url, script, task))
}

fn request(body: &Value) -> String {
    matching::key("/v1/responses", body, &Placeholders::default()).user_request
}

pub(super) fn steward(body: &Value) -> bool {
    body["instructions"]
        .as_str()
        .unwrap_or_default()
        .contains("You run one delegated Work for Butler")
}

/// A Butler round of the Turn the user started with `text`.
pub(super) fn asks(body: &Value, text: &str) -> bool {
    !steward(body)
        && request(body)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            == text
}

pub(super) fn returning(body: &Value) -> bool {
    !steward(body) && request(body).starts_with("Delegated result")
}

fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "function_call_output")
        .filter_map(|item| serde_json::from_str::<Value>(item["output"].as_str()?).ok())
        .map(|value| value.get("output").cloned().unwrap_or(value))
        .collect()
}

fn proposal(project: &str, summary: &str, titles: &[&str]) -> Value {
    let changes: Vec<_> = titles
        .iter()
        .map(|title| json!({"op":"epic.create","title":title,"description":"범위와 완료 기준"}))
        .collect();
    json!({"project_id":project,"summary":summary,"changes":changes})
}

fn steward_calls(outputs: &[Value]) -> Vec<(&'static str, Value)> {
    let work = outputs
        .iter()
        .rev()
        .find_map(|v| v.pointer("/work/work_id"))
        .cloned()
        .unwrap_or(Value::Null);
    let done = json!([{"action_key":"research","status":"done"}]);
    vec![
        (
            "replace_work_plan",
            json!({"objective":"조사 후 과제 변경안 정리","execution_mode":"direct",
            "actions":[{"action_key":"research","description":"조사하고 과제 변경안을 정리"}],
            "checks":["과제 변경안이 결과에 있다"]}),
        ),
        (
            "record_work_review",
            json!({"subject":"plan","verdict":"accept","summary":"범위 충분"}),
        ),
        (
            "record_work_disposition",
            json!({"work_id":work,"disposition":"completed","summary":REPORT,
            "action_updates":done,"remaining_actions":[],"followups":[]}),
        ),
    ]
}

/// The calls of the current request's Turn, and the text that ends it.
fn script(body: &Value, project: &str) -> (Vec<(&'static str, Value)>, &'static str) {
    if steward(body) {
        (steward_calls(&outputs(body)), REPORT)
    } else if returning(body) {
        let args = proposal(project, "조사 결과 반영", &PROPOSED);
        (vec![("canon_propose", args)], APPLIED)
    } else if asks(body, CREATE) {
        let args = proposal(project, "앞으로 진행할 과제", &CREATED);
        (vec![("canon_propose", args)], "과제 세 개를 등록했습니다.")
    } else if asks(body, RESEARCH) {
        let args = json!({"request":RESEARCH,"checks":["과제 변경안이 결과에 있다"]});
        (vec![("delegate_to_steward", args)], "조사를 맡겼습니다.")
    } else {
        (Vec::new(), "확인했습니다.")
    }
}

async fn reply(State(script): State<Arc<Script>>, Json(body): Json<Value>) -> impl IntoResponse {
    script.requests.lock().unwrap().push(body.clone());
    let project = script.project.lock().unwrap().clone();
    let (mut calls, text) = self::script(&body, &project);
    let round = matching::key("/v1/responses", &body, &Placeholders::default()).round;
    let n = round
        .iter()
        .filter(|kind| kind.as_str() == "function_call_output")
        .count();
    let item = if n < calls.len() {
        let (name, args) = calls.remove(n);
        json!({"type":"function_call","id":format!("fc_route_{n}"),"call_id":format!("call_route_{n}"),
            "name":name,"arguments":args.to_string(),"status":"completed"})
    } else {
        json!({"type":"message","id":"msg_route","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":text,"annotations":[]}]})
    };
    (
        [("content-type", "text/event-stream")],
        crate::token_cache::wire(&item),
    )
}
