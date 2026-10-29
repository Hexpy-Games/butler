//! One stdio tool call with caller-supplied identity and strict arguments.
use super::{HarnessError, agent::Launch, harness_error};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub async fn tool(
    launch: &Launch,
    log: &Path,
    client: Value,
    name: &str,
    arguments: Value,
) -> Result<Value, HarnessError> {
    let mut command = tokio::process::Command::from(launch.command());
    let mut child = command
        .args(["mcp", "serve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(log)?)
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| harness_error("MCP stdin unavailable"))?;
    let mut lines = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| harness_error("MCP stdout unavailable"))?,
    )
    .lines();
    let messages = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":client}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":name,"arguments":arguments}}),
    ];
    let mut reply = Value::Null;
    for message in messages {
        stdin.write_all(format!("{message}\n").as_bytes()).await?;
        stdin.flush().await?;
        if let Some(id) = message["id"].as_u64() {
            reply = tokio::time::timeout(Duration::from_secs(30), async {
                while let Some(line) = lines.next_line().await? {
                    let value: Value = serde_json::from_str(&line)?;
                    if value["id"] == id {
                        return Ok::<_, HarnessError>(value);
                    }
                }
                Err(harness_error("MCP closed before reply"))
            })
            .await
            .map_err(|_| harness_error("MCP reply timeout"))??;
        }
    }
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .is_err()
    {
        child.kill().await?;
        child.wait().await?;
    }
    Ok(reply)
}
