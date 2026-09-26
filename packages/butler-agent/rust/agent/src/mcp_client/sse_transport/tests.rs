use std::{collections::HashMap, sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, mpsc},
};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::super::session::{Operation, run_session};
use super::{LegacySseTransport, headers};

struct FixtureState {
    responses: Mutex<mpsc::Receiver<Value>>,
    response_tx: mpsc::Sender<Value>,
    auth_seen: std::sync::atomic::AtomicBool,
    cancel: CancellationToken,
}

#[tokio::test]
async fn legacy_sse_endpoint_posts_and_receives_through_scoped_rmcp_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let source = Url::parse(&format!("http://{address}/sse")).unwrap();
    let (response_tx, response_rx) = mpsc::channel(32);
    let cancel = CancellationToken::new();
    let state = Arc::new(FixtureState {
        responses: Mutex::new(response_rx),
        response_tx,
        auth_seen: std::sync::atomic::AtomicBool::new(false),
        cancel: cancel.clone(),
    });
    let server_state = state.clone();
    let server = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                () = server_state.cancel.cancelled() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((socket, _)) = accepted else {
                break;
            };
            let connection_state = server_state.clone();
            tokio::spawn(async move {
                serve_connection(socket, connection_state).await;
            });
        }
    });

    let transport = LegacySseTransport::connect(
        reqwest::Client::new(),
        source,
        headers(&[("x-fixture-auth".into(), "local-secret".into())]).unwrap(),
        CancellationToken::new(),
    );
    let signal = CancellationToken::new();
    let result = run_session(
        transport,
        Operation::CallTool {
            name: "echo".into(),
            arguments: serde_json::Map::from_iter([("text".into(), json!("sse request"))]),
        },
        Duration::from_secs(3),
        &signal,
    )
    .await
    .expect("SSE MCP call");

    assert_eq!(result["content"][0]["text"], "sse-proof:sse request");
    assert_eq!(result["structuredContent"]["transport"], "sse");
    assert!(state.auth_seen.load(std::sync::atomic::Ordering::Acquire));
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

async fn serve_connection(mut socket: TcpStream, state: Arc<FixtureState>) {
    let Some(request) = read_request(&mut socket).await else {
        return;
    };
    if request.headers.get("x-fixture-auth").map(String::as_str) == Some("local-secret") {
        state
            .auth_seen
            .store(true, std::sync::atomic::Ordering::Release);
    }
    if request.path == "/sse" {
        if socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n",
            )
            .await
            .is_err()
        {
            return;
        }
        if socket
            .write_all(b"event: endpoint\ndata: /message\n\n")
            .await
            .is_err()
        {
            return;
        }
        let mut responses = state.responses.lock().await;
        loop {
            let response = tokio::select! {
                () = state.cancel.cancelled() => return,
                response = responses.recv() => response,
            };
            let Some(response) = response else {
                return;
            };
            let Ok(encoded) = serde_json::to_vec(&response) else {
                return;
            };
            if socket.write_all(b"event: message\ndata: ").await.is_err()
                || socket.write_all(&encoded).await.is_err()
                || socket.write_all(b"\n\n").await.is_err()
            {
                return;
            }
        }
    }
    if request.path == "/message" {
        if let Ok(message) = serde_json::from_slice::<Value>(&request.body)
            && let Some(response) = response_for(&message)
        {
            let _ = state.response_tx.send(response).await;
        }
        let _ = socket
            .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
    } else {
        let _ = socket
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
    }
}

struct Request {
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_request(socket: &mut TcpStream) -> Option<Request> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    let (header_end, body_length) = loop {
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&bytes[..end]);
            let length = header
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                break (end, length);
            }
        }
        let count = socket.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
    };
    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header.lines();
    let path = lines.next()?.split_whitespace().nth(1)?.to_owned();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    Some(Request {
        path,
        headers,
        body: bytes[header_end + 4..header_end + 4 + body_length].to_vec(),
    })
}

fn response_for(message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message.get("method").and_then(Value::as_str)?;
    let result = match method {
        "initialize" => json!({
            "protocolVersion":message["params"]["protocolVersion"],
            "capabilities":{"tools":{}},
            "serverInfo":{"name":"sse-fixture","version":"1"},
        }),
        "tools/call" => {
            let text = message["params"]["arguments"]["text"]
                .as_str()
                .unwrap_or_default();
            json!({
                "content":[{"type":"text","text":format!("sse-proof:{text}")}],
                "isError":false,
                "structuredContent":{"transport":"sse"},
            })
        }
        _ => {
            return Some(json!({
                "jsonrpc":"2.0",
                "id":id,
                "error":{"code":-32601,"message":"Method not found"},
            }));
        }
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}
