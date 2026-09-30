//! Tiny stdio MCP server for E2E scenarios (MCP-01..03).
//!
//! Tool `e2e_echo` answers with the value of `E2E_MCP_NONCE` (so only real
//! execution can surface it). `E2E_MCP_MODE` selects misbehaviour on
//! `tools/call`: `crash` (exit), `hang` (never answer), `malformed` (invalid
//! JSON-RPC). `E2E_MCP_REQUIRE_SECRET=<name>`: `initialize` fails unless
//! that env var is set (proves a stored secret still reaches the server).

use std::io::{BufRead, Write};

use serde_json::{Value, json};

fn main() {
    prepare_process();
    let mode = std::env::var("E2E_MCP_MODE").unwrap_or_default();
    let nonce = std::env::var("E2E_MCP_NONCE").unwrap_or_default();
    let required = std::env::var("E2E_MCP_REQUIRE_SECRET").unwrap_or_default();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { return };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = request.get("id").cloned() else {
            continue; // notification
        };
        let method = request["method"].as_str().unwrap_or_default();
        let result = match method {
            "initialize" => {
                if mode == "hang_init" {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(3600));
                    }
                }
                if !required.is_empty() && std::env::var(&required).is_err() {
                    Err(json!({"code": -32000, "message": "required secret missing"}))
                } else {
                    Ok(json!({
                        "protocolVersion": request["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "e2e-mcp-fixture", "version": "1.0.0"}
                    }))
                }
            }
            "tools/list" => Ok(json!({"tools": [{
                "name": "e2e_echo",
                "description": "Returns the E2E fixture's per-run token.",
                "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
            }]})),
            "tools/call" => match mode.as_str() {
                "crash" => std::process::exit(3),
                "hang" => loop {
                    std::thread::sleep(std::time::Duration::from_secs(3600));
                },
                "malformed" => {
                    let _ = writeln!(stdout, "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":");
                    let _ = stdout.flush();
                    continue;
                }
                _ => {
                    Ok(json!({"content": [{"type": "text", "text": format!("e2e token {nonce}")}]}))
                }
            },
            "ping" => Ok(json!({})),
            _ => Err(json!({"code": -32601, "message": "method not found"})),
        };
        let response = match result {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
        };
        let _ = writeln!(stdout, "{response}");
        let _ = stdout.flush();
    }
}

fn prepare_process() {
    if std::env::args().any(|arg| arg == "--descendant") {
        if let Ok(path) = std::env::var("E2E_MCP_CHILD_PID_FILE") {
            let _ = std::fs::write(path, std::process::id().to_string());
        }
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }
    if std::env::var("E2E_MCP_CHILD_PID_FILE").is_ok() {
        let child = std::env::current_exe().ok().and_then(|exe| {
            std::process::Command::new(exe)
                .arg("--descendant")
                .spawn()
                .ok()
        });
        if child.is_none() {
            std::process::exit(2);
        }
    }
    if let Ok(path) = std::env::var("E2E_MCP_PID_FILE")
        && std::fs::write(path, std::process::id().to_string()).is_err()
    {
        std::process::exit(2);
    }
}
