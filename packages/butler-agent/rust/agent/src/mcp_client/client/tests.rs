use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, Write},
    path::PathBuf,
    time::Duration,
};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::super::NativeMcpClient;

mod streamable_http;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("butler-mcp-client-{}", uuid::Uuid::new_v4())))
    }

    fn write_registry(&self, server: &Value) {
        let config = self.0.join("config");
        fs::create_dir_all(&config).unwrap();
        fs::write(
            config.join("mcp-servers.json"),
            serde_json::to_vec(&json!({"version":1,"servers":[server]})).unwrap(),
        )
        .unwrap();
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn stdio_client_lists_describes_calls_and_reads_then_reaps_each_child() {
    let scratch = Scratch::new();
    let marker = scratch.0.join("reaped.txt");
    let executable = std::env::current_exe().unwrap();
    scratch.write_registry(&json!({
        "id":"fixture",
        "display_name":"Fixture",
        "enabled":true,
        "transport":"stdio",
        "command":executable,
        "args":["--exact", "mcp_client::client::tests::stdio_fixture_child", "--ignored"],
        "env":[{"key":"MCP_FIXTURE_MARKER","source":"literal","value":marker.to_string_lossy()}],
    }));
    let client = NativeMcpClient::new(
        scratch.0.clone(),
        HashMap::from([("BUTLER_TEST_PARENT_SECRET".into(), "not-forwarded".into())]),
    );
    let signal = CancellationToken::new();

    let capabilities = Box::pin(tokio::time::timeout(
        Duration::from_secs(8),
        client.list_capabilities(false, &signal),
    ))
    .await
    .unwrap()
    .unwrap();
    assert_eq!(capabilities["servers"][0]["tools"][0]["name"], "echo");
    assert_eq!(
        Box::pin(client.describe_tool_schema("fixture", "echo", &signal))
            .await
            .unwrap()
            .unwrap()["input_schema"]["properties"]["text"]["type"],
        "string"
    );
    let called = Box::pin(client.call_tool(
        "fixture",
        "echo",
        serde_json::Map::from_iter([("text".into(), json!("stdio-proof"))]),
        &signal,
    ))
    .await
    .unwrap();
    assert_eq!(called["result"]["content"][0]["text"], "stdio-proof");
    assert_eq!(
        called["result"]["structuredContent"]["ambient_secret_absent"],
        true
    );
    assert_eq!(
        Box::pin(client.read_resource("fixture", "file://fixture", &signal))
            .await
            .unwrap()["result"]["contents"][0]["text"],
        "stdio-resource-proof"
    );
    let exits = fs::read_to_string(marker).unwrap();
    assert_eq!(exits.lines().count(), 4, "every scoped stdio child exited");
}

#[tokio::test]
async fn stdio_cancellation_reaps_child_after_one_tool_dispatch() {
    let scratch = Scratch::new();
    let dispatched = scratch.0.join("dispatched.txt");
    let pid_marker = scratch.0.join("pid.txt");
    let executable = std::env::current_exe().unwrap();
    scratch.write_registry(&json!({
        "id":"fixture",
        "display_name":"Fixture",
        "enabled":true,
        "transport":"stdio",
        "command":executable,
        "args":["--exact", "mcp_client::client::tests::stdio_hanging_call_fixture_child", "--ignored"],
        "env":[
            {"key":"MCP_FIXTURE_DISPATCHED","source":"literal","value":dispatched.to_string_lossy()},
            {"key":"MCP_FIXTURE_PID","source":"literal","value":pid_marker.to_string_lossy()},
        ],
    }));
    let client = NativeMcpClient::new(scratch.0.clone(), HashMap::new());
    let signal = CancellationToken::new();
    let call_signal = signal.clone();
    let call = tokio::spawn(async move {
        Box::pin(client.call_tool("fixture", "hang", serde_json::Map::new(), &call_signal)).await
    });

    tokio::time::timeout(Duration::from_secs(5), async {
        while !dispatched.exists() || !pid_marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the fixture child should receive the tool call");
    let pid = fs::read_to_string(pid_marker)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    signal.cancel();

    let error = tokio::time::timeout(Duration::from_secs(7), call)
        .await
        .expect("cancelled MCP call should finish within the cleanup bound")
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "turn_cancelled");
    assert!(error.attempted, "the remote call was already dispatched");
    assert_eq!(
        fs::read_to_string(dispatched).unwrap().lines().count(),
        1,
        "an attempted call must not be repeated"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while process_is_running(pid) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the scoped stdio child should be killed and reaped");
}

#[test]
#[ignore = "stdio MCP server child; spawned with --ignored by the stdio client tests"]
fn stdio_fixture_child() {
    let Ok(marker) = std::env::var("MCP_FIXTURE_MARKER") else {
        return;
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(response) = response_for(&request) {
            let Ok(mut encoded) = serde_json::to_vec(&response) else {
                break;
            };
            encoded.push(b'\n');
            if stdout.write_all(&encoded).is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(marker)
        .unwrap();
    file.write_all(b"closed\n").unwrap();
}

#[test]
#[ignore = "hanging stdio MCP server child; spawned with --ignored by the cancellation test"]
fn stdio_hanging_call_fixture_child() {
    let (Ok(dispatched), Ok(pid_marker)) = (
        std::env::var("MCP_FIXTURE_DISPATCHED"),
        std::env::var("MCP_FIXTURE_PID"),
    ) else {
        return;
    };
    fs::write(pid_marker, std::process::id().to_string()).unwrap();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if request.get("method").and_then(Value::as_str) == Some("tools/call") {
            let mut marker = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dispatched)
                .unwrap();
            marker.write_all(b"dispatched\n").unwrap();
            std::thread::sleep(Duration::from_secs(120));
            return;
        }
        if let Some(response) = response_for(&request) {
            let mut encoded = serde_json::to_vec(&response).unwrap();
            encoded.push(b'\n');
            if stdout.write_all(&encoded).is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
}

#[cfg(unix)]
fn process_is_running(pid: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(windows)]
fn process_is_running(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .ok()
        .is_some_and(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.split_whitespace().nth(1) == Some(pid.to_string().as_str()))
        })
}

#[cfg(not(any(unix, windows)))]
fn process_is_running(_: u32) -> bool {
    false
}

fn response_for(request: &Value) -> Option<Value> {
    let id = request.get("id")?.clone();
    let method = request.get("method").and_then(Value::as_str)?;
    let result = match method {
        "initialize" => json!({
            "protocolVersion":request["params"]["protocolVersion"],
            "capabilities":{"tools":{"listChanged":false},"resources":{}},
            "serverInfo":{"name":"stdio-fixture","version":"1"},
        }),
        "tools/list" => json!({"tools":[{
            "name":"echo",
            "description":"Echo text from the scoped stdio fixture.",
            "inputSchema":{"type":"object","properties":{"text":{"type":"string"}}},
        }]}),
        "resources/list" => json!({"resources":[{
            "uri":"file://fixture","name":"Fixture resource","mimeType":"text/plain",
        }]}),
        "resources/templates/list" => json!({"resourceTemplates":[]}),
        "tools/call" => json!({
            "content":[{"type":"text","text":request["params"]["arguments"]["text"]}],
            "isError":false,
            "structuredContent":{"ambient_secret_absent":std::env::var_os("BUTLER_TEST_PARENT_SECRET").is_none()},
        }),
        "resources/read" => json!({"contents":[{
            "uri":"file://fixture","mimeType":"text/plain","text":"stdio-resource-proof",
        }]}),
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
