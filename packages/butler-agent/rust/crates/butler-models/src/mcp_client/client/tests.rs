use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, Write},
    path::PathBuf,
    time::Duration,
};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::super::McpClient;

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
    let client = McpClient::new(
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
