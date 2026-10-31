use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{matching, sanitize::Placeholders};
use std::sync::{Arc, Mutex};
#[derive(Default)]
pub(crate) struct Script {
    pub replies: Mutex<std::collections::HashMap<String, Vec<Value>>>,
    pub requests: Mutex<Vec<Value>>,
}
pub(crate) async fn start()
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
async fn reply(State(script): State<Arc<Script>>, Json(body): Json<Value>) -> impl IntoResponse {
    script.requests.lock().unwrap().push(body.clone());
    let key = matching::key("/v1/responses", &body, &Placeholders::default());
    let n = key
        .round
        .iter()
        .filter(|k| k.as_str() == "function_call_output")
        .count();
    let mut item = script
        .replies
        .lock()
        .unwrap()
        .get(&key.user_request)
        .and_then(|r| r.get(n))
        .cloned()
        .unwrap_or_else(|| final_reply(&body));
    if let Some(raw) = item["arguments"].as_str().filter(|s| s.contains("$work")) {
        let work = body["input"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .filter_map(|i| i["output"].as_str())
            .filter_map(|s| serde_json::from_str::<Value>(s).ok())
            .find_map(|v| {
                v.pointer("/output/work/work_id")
                    .or_else(|| v.pointer("/work/work_id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        if let Some(work) = work {
            item["arguments"] = json!(raw.replace("$work", &work));
        }
    }
    if let Some(raw) = item["arguments"].as_str().filter(|s| s.contains("$epic")) {
        let epic = body["input"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .filter_map(|i| i["output"].as_str())
            .filter_map(|s| serde_json::from_str::<Value>(s).ok())
            .find_map(|v| {
                v.get("output").unwrap_or(&v)["bound"][0]
                    .as_str()
                    .map(str::to_owned)
            });
        if let Some(epic) = epic {
            item["arguments"] = json!(raw.replace("canon:epic/$epic", &epic));
        }
    }
    (
        [("content-type", "text/event-stream")],
        crate::token_cache::wire(&item),
    )
}
fn final_reply(body: &Value) -> Value {
    let refused = body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| i["output"].as_str())
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .any(|r| r.get("output").unwrap_or(&r)["error"]["code"] == "read_only");
    let text = if refused {
        "이 대화는 읽기 전용이라 과제를 등록할 수 없으며, 권한 수준을 바꿀 수 있습니다."
    } else {
        "확인했습니다."
    };
    json!({"type":"message","id":"msg_done","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}
pub(crate) fn arm(script: &Script, message: &str, calls: Vec<(&str, Value)>) {
    let items=calls.into_iter().enumerate().map(|(n,(name,args))|json!({"type":"function_call","id":format!("fc_cp_{n}"),"call_id":format!("call_cp_{n}"),"name":name,"arguments":args.to_string(),"status":"completed"})).collect();
    script.replies.lock().unwrap().insert(
        message.split_whitespace().collect::<Vec<_>>().join(" "),
        items,
    );
}
pub(crate) fn results(script: &Script) -> Vec<Value> {
    script
        .requests
        .lock()
        .unwrap()
        .iter()
        .flat_map(|r| r["input"].as_array().unwrap().iter())
        .filter(|i| i["type"] == "function_call_output")
        .filter_map(|i| serde_json::from_str::<Value>(i["output"].as_str()?).ok())
        .map(|r| r.get("output").cloned().unwrap_or(r))
        .collect()
}
