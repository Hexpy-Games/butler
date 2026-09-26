use std::{collections::HashMap, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

use super::{NativeMcpClient, Scratch};

#[tokio::test]
async fn streamable_http_client_posts_initialize_and_call_with_auth_then_closes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let endpoint = format!("http://{address}/mcp");
    let server = tokio::spawn(async move {
        let mut observed = Vec::new();
        loop {
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .expect("client should close the loopback session")
                .unwrap();
            let (method, headers, body) = read_request(&mut socket).await;
            observed.push((method.clone(), headers, body.clone()));
            if method != "POST" {
                write_response(&mut socket, 405, "", "").await;
                continue;
            }
            let rpc_method = body.get("method").and_then(Value::as_str).unwrap_or("");
            if rpc_method == "notifications/initialized" {
                write_response(&mut socket, 202, "", "").await;
                continue;
            }
            let id = body.get("id").cloned().unwrap_or(Value::Null);
            let response = match rpc_method {
                "initialize" => json!({"jsonrpc":"2.0","id":id,"result":{
                    "protocolVersion":body["params"]["protocolVersion"],
                    "capabilities":{"tools":{}},
                    "serverInfo":{"name":"http-fixture","version":"1"},
                }}),
                "tools/call" => {
                    let response = json!({"jsonrpc":"2.0","id":id,"result":{
                        "content":[{"type":"text","text":"streamable-http-proof"}],
                        "isError":false,
                    }});
                    write_response(
                        &mut socket,
                        200,
                        "application/json",
                        &serde_json::to_string(&response).unwrap(),
                    )
                    .await;
                    break observed;
                }
                _ if id.is_null() => {
                    write_response(&mut socket, 202, "", "").await;
                    continue;
                }
                _ => json!({"jsonrpc":"2.0","id":id,"result":{}}),
            };
            write_response(
                &mut socket,
                200,
                "application/json",
                &serde_json::to_string(&response).unwrap(),
            )
            .await;
        }
    });

    let scratch = Scratch::new();
    scratch.write_registry(&json!({
        "id":"http-fixture",
        "display_name":"HTTP fixture",
        "enabled":true,
        "transport":"http",
        "url":endpoint,
        "headers":[{"key":"x-mcp-fixture-key","source":"literal","value":"fixture-secret"}],
    }));
    let client = NativeMcpClient::new(scratch.0.clone(), HashMap::new());
    let result = Box::pin(tokio::time::timeout(
        Duration::from_secs(8),
        client.call_tool(
            "http-fixture",
            "echo",
            serde_json::Map::from_iter([("text".into(), json!("request"))]),
            &CancellationToken::new(),
        ),
    ))
    .await
    .expect("the loopback MCP call should complete")
    .unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["result"]["content"][0]["text"],
        "streamable-http-proof"
    );

    let requests = tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .expect("the server should observe the request and session close")
        .unwrap();
    let methods = requests
        .iter()
        .filter_map(|(_, _, body)| body.get("method").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert!(methods.contains(&"initialize"));
    assert!(methods.contains(&"tools/call"));
    assert!(methods.contains(&"notifications/initialized"));
    assert!(requests.iter().all(|(_, headers, _)| {
        headers.get("x-mcp-fixture-key").map(String::as_str) == Some("fixture-secret")
    }));
}

async fn read_request(socket: &mut TcpStream) -> (String, HashMap<String, String>, Value) {
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0, "HTTP request ended before its body arrived");
        bytes.extend_from_slice(&chunk[..read]);
        let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
            continue;
        };
        let header_text = String::from_utf8_lossy(&bytes[..header_end]);
        let content_length = header_text
            .lines()
            .skip(1)
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        if bytes.len() < header_end + 4 + content_length {
            continue;
        }
        let mut lines = header_text.lines();
        let method = lines
            .next()
            .and_then(|line| line.split_whitespace().next())
            .unwrap_or("")
            .to_owned();
        let headers = lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            })
            .collect();
        let body = serde_json::from_slice(&bytes[header_end + 4..header_end + 4 + content_length])
            .unwrap_or(Value::Null);
        return (method, headers, body);
    }
}

async fn write_response(socket: &mut TcpStream, status: u16, content_type: &str, body: &str) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        _ => "Method Not Allowed",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(headers.as_bytes()).await.unwrap();
    socket.write_all(body.as_bytes()).await.unwrap();
}
