//! Documented wire-format replay cassettes; public provider API in a subprocess.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "replay assertions")]
use butler_e2e::e2e::binary::fixture_binary;
use butler_e2e::e2e::{HarnessError, cassette::ResponseRecord};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    process::Command,
};

fn fixtures() -> Vec<Value> {
    [
        include_str!("../fixtures/provider-streaming/anthropic.json"),
        include_str!("../fixtures/provider-streaming/responses.json"),
        include_str!("../fixtures/provider-streaming/gemini.json"),
        include_str!("../fixtures/provider-streaming/chat.json"),
        include_str!("../fixtures/provider-streaming/gemini-text-parts.json"),
    ]
    .into_iter()
    .map(|text| serde_json::from_str(text).unwrap())
    .collect()
}

#[tokio::test]
async fn provider_streaming_replays_preserve_complete_results_and_order() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut replays = fixtures();
    let mut without_thoughts = replays[2].clone();
    without_thoughts["expected"]["usageMetadata"]
        .as_object_mut()
        .unwrap()
        .remove("thoughtsTokenCount");
    without_thoughts["expected"]["usageMetadata"]["totalTokenCount"] = json!(135);
    for chunk in without_thoughts["response"]["chunks"]
        .as_array_mut()
        .unwrap()
    {
        chunk["text"] = chunk["text"]
            .as_str()
            .unwrap()
            .replace("\"thoughtsTokenCount\":3,", "")
            .replace("\"totalTokenCount\":138", "\"totalTokenCount\":135")
            .into();
    }
    replays.push(without_thoughts);
    for fixture in replays {
        let streamed: ResponseRecord = serde_json::from_value(fixture["response"].clone())?;
        let json = ResponseRecord {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            chunks: vec![butler_e2e::e2e::cassette::Chunk {
                delay_ms: 0,
                text: fixture["expected"].to_string(),
            }],
        };
        let server = Server::new(vec![(json, false), (streamed, false)]).await?;
        let report = invoke(&server, &fixture, 2, 1).await?;
        assert_eq!(
            report["results"][0], report["results"][1],
            "{}",
            fixture["model"]
        );
        assert_eq!(report["results"][1]["raw"], fixture["expected"]);
        assert_eq!(
            report["results"][1]["toolCalls"].as_array().unwrap().len(),
            2
        );
        assert_eq!(report["results"][1]["text"], fixture["expected_text"]);
        if fixture["model"] == "google/gemini-3.8-flash" {
            let reported = &fixture["expected"]["usageMetadata"];
            let usage = &report["results"][1]["usage"];
            let thoughts = reported["thoughtsTokenCount"].as_f64().unwrap_or(0.0);
            assert_eq!(
                usage["promptTokens"].as_f64(),
                reported["promptTokenCount"].as_f64()
            );
            assert_eq!(
                usage["outputTokens"],
                reported["candidatesTokenCount"].as_f64().unwrap() + thoughts
            );
            if reported.get("thoughtsTokenCount").is_some() {
                assert_eq!(usage["reasoningTokens"], thoughts);
            } else {
                assert!(usage.get("reasoningTokens").is_none());
            }
        }
        verify_events(&report["events"], &report["results"][1], &fixture);
        verify_requests(&server, &fixture);
    }
    // The same Responses reader also serves hosted OpenAI Responses routes.
    let mut fixture = fixtures().remove(1);
    fixture["model"] = "qwen/qwen3.7-max".into();
    fixture["shape"] = "responses".into();
    let streamed = serde_json::from_value(fixture["response"].clone())?;
    let server = Server::new(vec![(streamed, false)]).await?;
    let report = invoke(&server, &fixture, 1, 1).await?;
    assert_eq!(report["results"][0]["raw"], fixture["expected"]);
    verify_events(&report["events"], &report["results"][0], &fixture);
    Ok(())
}

#[tokio::test]
async fn provider_streaming_disconnects_use_existing_retry_policy() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for fixture in fixtures() {
        let complete: ResponseRecord = serde_json::from_value(fixture["response"].clone())?;
        let mut partial = complete.clone();
        let body = complete.body();
        // End before the terminal event/finish reason, after arguments and text arrived.
        let cut = body
            .find(if fixture["model"] == "qwen/qwen3.7-max" {
                "\"finish_reason\":\"tool_calls\""
            } else if fixture["model"] == "google/gemini-3.8-flash" {
                "\"finishReason\""
            } else if fixture["model"] == "anthropic/claude-haiku-4-5" {
                "\"type\":\"message_delta\""
            } else {
                "\"type\":\"response.completed\""
            })
            .unwrap();
        let cut = body[..cut].rfind("data:").unwrap();
        partial.chunks[0].text = body[..cut].to_owned();
        for broken_length in [false, true] {
            let server = Server::new(vec![
                (partial.clone(), broken_length),
                (complete.clone(), false),
            ])
            .await?;
            let report = invoke(&server, &fixture, 1, 2).await?;
            assert_eq!(report["results"][0]["raw"], fixture["expected"]);
            assert!(
                report["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["type"] == "discarded")
            );
            assert_eq!(server.requests.lock().unwrap().len(), 2);
        }
        let server = Server::new(vec![(partial, false)]).await?;
        let report = invoke(&server, &fixture, 1, 1).await?;
        assert_eq!(
            report["results"][0],
            json!({"error":"provider_stream_interrupted","retryable":true})
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
    Ok(())
}

#[tokio::test]
async fn provider_streaming_preserves_terminal_stop_reasons() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (index, from, to) in [
        (0, "tool_use", "max_tokens"),
        (0, "tool_use", "refusal"),
        (1, "completed", "incomplete"),
        (2, "STOP", "SAFETY"),
        (3, "tool_calls", "length"),
        (3, "tool_calls", "content_filter"),
    ] {
        let mut fixture = fixtures().remove(index);
        let mut response: ResponseRecord = serde_json::from_value(fixture["response"].clone())?;
        let path = match index {
            0 => "/stop_reason",
            1 => "/status",
            2 => "/candidates/0/finishReason",
            _ => "/choices/0/finish_reason",
        };
        *fixture["expected"].pointer_mut(path).unwrap() = to.into();
        let failure = match to {
            "refusal" => Some("provider_response_refused"),
            "SAFETY" | "content_filter" => Some("provider_safety_error"),
            _ => None,
        };
        let key = match index {
            0 => "stop_reason",
            1 => "status",
            2 => "finishReason",
            _ => "finish_reason",
        };
        let from = format!("\"{key}\":\"{from}\"");
        let to = format!("\"{key}\":\"{to}\"");
        if index == 1 {
            fixture["expected"]["incomplete_details"] = json!({"reason":"max_output_tokens"});
            response.chunks[0].text = response.chunks[0].text.replace(
                "\"status\":\"completed\",\"output\":", "\"status\":\"completed\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"output\":");
            let body = &response.chunks[0].text;
            let terminal = body.find("\"type\":\"response.completed\"").unwrap();
            response.chunks[0].text = format!(
                "{}{}",
                &body[..terminal],
                body[terminal..].replacen(&from, &to, 1).replace(
                    "\"type\":\"response.completed\"",
                    "\"type\":\"response.incomplete\""
                )
            );
        } else {
            response.chunks[0].text = response.chunks[0].text.replace(&from, &to);
        }
        let server = Server::new(vec![(response, false)]).await?;
        let report = invoke(&server, &fixture, 1, 1).await?;
        if let Some(code) = failure {
            assert_eq!(
                report["results"][0],
                json!({"error":code,"retryable":false})
            );
        } else {
            assert_eq!(report["results"][0]["raw"], fixture["expected"]);
            verify_events(&report["events"], &report["results"][0], &fixture);
        }
    }
    Ok(())
}

#[tokio::test]
async fn provider_streaming_tool_only_failure_discards_draft() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = fixtures().remove(1);
    let mut response: ResponseRecord = serde_json::from_value(fixture["response"].clone())?;
    let body = response.body();
    let cut = body
        .find("\"type\":\"response.output_text.delta\"")
        .unwrap();
    response.chunks[0].text = body[..body[..cut].rfind("data:").unwrap()].to_owned();
    let server = Server::new(vec![(response, false)]).await?;
    let report = invoke(&server, &fixture, 1, 1).await?;
    assert_eq!(report["results"][0]["error"], "provider_stream_interrupted");
    assert!(
        report["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "discarded")
    );
    Ok(())
}

#[tokio::test]
async fn provider_streaming_in_band_errors_preserve_retry_decisions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for fixture in fixtures() {
        let model = fixture["model"].as_str().unwrap();
        for (status, retryable) in [(400, false), (401, false), (429, true)] {
            let error = if model.starts_with("anthropic/") {
                json!({"type":"error","error":{"type":if retryable {"overloaded_error"} else if status == 401 {"authentication_error"} else {"invalid_request_error"},"message":"Replay failure"}})
            } else if model.starts_with("openai/") {
                json!({"type":"error","code":if retryable {"rate_limit_exceeded"} else if status == 401 {"invalid_api_key"} else {"invalid_request"},"message":"Replay failure"})
            } else {
                json!({"error":{"code":status,"message":"Replay failure"}})
            };
            let mut response: ResponseRecord = serde_json::from_value(fixture["response"].clone())?;
            response.chunks[0].text = format!("data: {error}\n\n");
            let complete: ResponseRecord = serde_json::from_value(fixture["response"].clone())?;
            let server =
                Server::new(vec![(response.clone(), false), (complete.clone(), false)]).await?;
            let report = invoke(&server, &fixture, 1, 2).await?;
            // Compare with today's HTTP-error path, including its existing Chat fallback.
            response.status = if !retryable {
                status
            } else if model.starts_with("anthropic/") {
                529
            } else {
                429
            };
            response.headers[0].1 = "application/json".into();
            response.chunks[0].text = error.to_string();
            let reference = Server::new(vec![(response, false), (complete, false)]).await?;
            let reference_report = invoke(&reference, &fixture, 1, 2).await?;
            assert_eq!(report["results"], reference_report["results"], "{model}");
            assert_eq!(
                server.requests.lock().unwrap().len(),
                reference.requests.lock().unwrap().len()
            );
            if retryable {
                assert_eq!(report["results"][0]["raw"], fixture["expected"]);
            }
        }
    }
    Ok(())
}

/// Checks the streamed round's events (the last stream; an earlier JSON round
/// declares its calls after the fact under its own stream id).
fn verify_events(events: &Value, result: &Value, fixture: &Value) {
    let mut calls = std::collections::BTreeMap::new();
    let mut sequence = 0;
    let all = events.as_array().unwrap();
    let stream = &all.last().unwrap()["streamId"];
    for event in all.iter().filter(|event| &event["streamId"] == stream) {
        let current = event["sequence"].as_u64().unwrap();
        assert!(current > sequence);
        sequence = current;
        let index = event["callIndex"].as_u64().unwrap_or(0);
        match event["type"].as_str().unwrap() {
            "tool_call_start" => {
                assert_ne!(event["toolName"].as_str().unwrap(), "");
                let call = &result["toolCalls"][calls.len()];
                // The start names the same id the executed call carries.
                assert_eq!(event["callId"], call["id"], "{}", fixture["model"]);
                assert!(
                    calls
                        .insert(
                            index,
                            (event["toolName"].clone(), String::new(), Vec::new())
                        )
                        .is_none()
                );
            }
            "tool_call_delta" => {
                let (_, arguments, fragments) =
                    calls.get_mut(&index).expect("name must precede arguments");
                fragments.push(event["argumentsDelta"].clone());
                arguments.push_str(event["argumentsDelta"].as_str().unwrap());
            }
            _ => {}
        }
    }
    assert_eq!(calls.len(), 2);
    for ((index, (name, arguments, fragments)), call) in
        calls.iter().zip(result["toolCalls"].as_array().unwrap())
    {
        assert_eq!(name, &call["name"]);
        assert_eq!(
            &Value::Array(fragments.clone()),
            &fixture["argument_fragments"][index.to_string()]
        );
        let parsed: Value = serde_json::from_str(arguments).unwrap();
        assert_eq!(parsed, call["arguments"]);
    }
}

fn verify_requests(server: &Server, fixture: &Value) {
    for request in server.requests.lock().unwrap().iter() {
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        let body: Value = serde_json::from_str(body).unwrap();
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("accept: text/event-stream")
        );
        if fixture["model"].as_str().unwrap().starts_with("google/") {
            assert!(headers.contains(":streamGenerateContent?alt=sse"));
        } else {
            assert_eq!(body["stream"], true);
        }
        if fixture["model"] == "qwen/qwen3.7-max" {
            assert_eq!(body["stream_options"]["include_usage"], true);
        }
    }
}

struct Server {
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<Result<(), HarnessError>>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn new(responses: Vec<(ResponseRecord, bool)>) -> Result<Self, HarnessError> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            for (response, broken_length) in responses {
                let (mut socket, _) = listener.accept().await?;
                let request = read_request(&mut socket).await?;
                captured.lock().unwrap().push(request);
                let body = response.body();
                let mut headers = String::new();
                for (key, value) in &response.headers {
                    headers.push_str(key);
                    headers.push_str(": ");
                    headers.push_str(value);
                    headers.push_str("\r\n");
                }
                let head = format!(
                    "HTTP/1.1 {} Replay\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    response.status,
                    body.len() + usize::from(broken_length)
                );
                socket.write_all(head.as_bytes()).await?;
                // Split inside JSON, SSE delimiters and UTF-8 characters.
                for chunk in body.as_bytes().chunks(7) {
                    socket.write_all(chunk).await?;
                }
            }
            Ok(())
        });
        Ok(Self {
            endpoint,
            requests,
            task,
        })
    }
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Result<String, HarnessError> {
    let mut request = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            return Err(HarnessError("request truncated".into()));
        }
        request.extend_from_slice(&chunk[..read]);
        if let Some(index) = request.windows(4).position(|w| w == b"\r\n\r\n") {
            let length = String::from_utf8_lossy(&request[..index])
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|s| s.trim().parse::<usize>().ok())
                })
                .unwrap();
            if request.len() == index + 4 + length {
                return Ok(String::from_utf8(request).unwrap());
            }
        }
    }
}

async fn invoke(
    server: &Server,
    fixture: &Value,
    rounds: usize,
    attempts: usize,
) -> Result<Value, HarnessError> {
    let dir = PathBuf::from(std::env::var("BUTLER_DATA").map_err(|e| HarnessError(e.to_string()))?)
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir)?;
    let stdout = dir.join("stdout.json");
    let stderr = dir.join("stderr.log");
    let endpoint = format!("{}{}", server.endpoint, fixture["path"].as_str().unwrap());
    let mut child = Command::new(fixture_binary("e2e-provider-streaming")?)
        .args([
            endpoint.as_str(),
            fixture["model"].as_str().unwrap(),
            fixture["shape"].as_str().unwrap(),
            &rounds.to_string(),
            &attempts.to_string(),
        ])
        .stdout(std::fs::File::create(&stdout)?)
        .stderr(std::fs::File::create(&stderr)?)
        .kill_on_drop(true)
        .spawn()?;
    let status = child.wait().await?;
    assert!(status.success(), "{}", std::fs::read_to_string(&stderr)?);
    serde_json::from_slice(&std::fs::read(&stdout)?).map_err(Into::into)
}

#[path = "provider_streaming/followups.rs"]
mod followups;
#[path = "provider_streaming/stops.rs"]
mod stops;

#[path = "provider_streaming/optional_finish_and_safety.rs"]
mod optional_finish_and_safety;
