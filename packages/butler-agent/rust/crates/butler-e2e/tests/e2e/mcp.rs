//! H. MCP servers (SCENARIOS.md MCP-01..03) with the stdio fixture server
//! `src/bin/e2e-mcp-fixture.rs`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, nonce};
use serde_json::{Value, json};

const FIXTURE: &str = env!("CARGO_BIN_EXE_e2e-mcp-fixture");
const PROMPT: &str =
    "Call the e2e_echo tool of the MCP server named e2e and tell me the token it returns.";

fn secret(key: &str, value: &str) -> Value {
    json!({"key": key, "source": "literal", "value": value})
}

async fn add_server(s: &Scenario, env: Vec<Value>) -> Result<Value, HarnessError> {
    let reply = s
        .gw
        .post(
            "/mcp-servers",
            json!({"id": "e2e", "display_name": "E2E fixture", "enabled": true, "transport": "stdio",
                   "command": butler_e2e::e2e::binary::mcp_fixture_binary(FIXTURE), "args": [], "env": env}),
        )
        .await?;
    assert!(reply.status < 300, "add server: {}", reply.text);
    Ok(reply.data().clone())
}

async fn probe(s: &Scenario) -> Result<Value, HarnessError> {
    let reply = s.gw.post("/mcp-servers/e2e/probe", json!({})).await?;
    Ok(reply.body)
}

fn healthy(probe: &Value) -> bool {
    probe["data"]["servers"]
        .as_array()
        .and_then(|servers| servers.iter().find(|server| server["id"] == "e2e"))
        .is_some_and(|server| server["ok"] == true)
}

/// MCP-01 — Add a server and use its tool.
#[tokio::test]
async fn mcp_01_add_server_and_use_its_tool() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = nonce();
    let s = Setup::new("MCP-01")?
        .cassette("MCP-01")
        .placeholder("NONCE", &token)
        .start()
        .await?;
    add_server(&s, vec![secret("E2E_MCP_NONCE", &token)]).await?;
    let probed = probe(&s).await?;
    assert!(healthy(&probed), "probe: {probed}");
    let capabilities = s.gw.get("/mcp-capabilities").await?;
    assert!(
        capabilities.text.contains("e2e_echo"),
        "tool not listed: {}",
        capabilities.text
    );
    let list = s.agent.cli(&["mcp", "list", "--json"])?;
    assert!(
        list.stdout.contains("e2e"),
        "CLI disagrees: {} {}",
        list.stdout,
        list.stderr
    );

    let (turn_id, turn) = s.turn("general", PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let mut outputs = String::new();
    for row in &rows {
        outputs.push_str(
            &s.gw
                .operation_output(&turn_id, row)
                .await
                .unwrap_or_default(),
        );
    }
    assert!(
        outputs.contains(&token),
        "MCP tool output lacks the per-run token: {rows:?}"
    );
    s.finish().await
}

/// MCP-02 — MCP secrets are never shown; a PATCH keeps the stored secret.
#[tokio::test]
async fn mcp_02_secrets_are_never_shown() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let canary = format!("e2e-canary-{}", uuid::Uuid::new_v4().simple());
    let s = Setup::new("MCP-02")?.start().await?;
    let created = add_server(
        &s,
        vec![
            secret("E2E_SECRET", &canary),
            secret("E2E_MCP_REQUIRE_SECRET", "E2E_SECRET"),
        ],
    )
    .await?;
    assert!(
        !created.to_string().contains(&canary),
        "POST echoed the secret"
    );
    assert!(healthy(&probe(&s).await?), "probe with secret failed");
    let listed = s.gw.get("/mcp-servers").await?;
    assert!(
        !listed.text.contains(&canary),
        "GET /mcp-servers shows the secret"
    );
    let cli = s.agent.cli(&["mcp", "list", "--json"])?;
    assert!(
        !cli.stdout.contains(&canary) && !cli.stderr.contains(&canary),
        "CLI shows the secret"
    );

    let patched =
        s.gw.patch(
            "/mcp-servers/e2e",
            json!({"display_name": "Renamed fixture"}),
        )
        .await?;
    assert!(patched.status < 300, "{}", patched.text);
    assert!(!patched.text.contains(&canary));
    let probed = probe(&s).await?;
    assert!(healthy(&probed), "secret lost after PATCH: {probed}");
    assert!(!s.agent.logs().contains(&canary), "secret in logs");
    s.finish().await
}

/// MCP-03 — Misbehaving MCP server: probe reports it, tool errors stay in
/// the turn, disable/delete work, the service stays healthy. Each mode has
/// its own recording of the model's real reaction to the failing tool.
#[tokio::test]
async fn mcp_03_misbehaving_server() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for mode in ["crash", "hang", "malformed"] {
        let mut s = Setup::new(&format!("MCP-03-{mode}"))?
            .cassette(&format!("MCP-03-{mode}"))
            .start()
            .await?;
        add_server(
            &s,
            vec![
                secret("E2E_MCP_MODE", mode),
                secret("E2E_MCP_NONCE", "unused"),
            ],
        )
        .await?;
        let (turn_id, turn, restarts) = s.turn_supervised("general", PROMPT).await?;
        assert_eq!(restarts, 0, "{mode}: the service exited and was replaced");
        assert!(
            matches!(turn_state(&turn), "delivered" | "failed"),
            "{mode}: {turn}"
        );
        let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
        let mcp_rows: Vec<&Value> = rows
            .iter()
            .filter(|row| row["safe_tool_name"] != "tool_search")
            .collect();
        assert!(
            mcp_rows.iter().any(|row| row["state"] != "delivered") || turn_state(&turn) == "failed",
            "{mode}: tool failure not visible: {rows:?}"
        );
        assert!(s.gw.healthy().await, "{mode}: service unhealthy");
        let disabled =
            s.gw.patch("/mcp-servers/e2e", json!({"enabled": false}))
                .await?;
        assert!(disabled.status < 300, "{mode}: {}", disabled.text);
        let deleted = s.gw.delete("/mcp-servers/e2e").await?;
        assert!(deleted.status < 300, "{mode}: {}", deleted.text);
        assert!(!s.gw.get("/mcp-servers").await?.text.contains("E2E fixture"));
        s.finish().await?;
    }
    // A server that dies during initialize is reported unhealthy by the probe.
    let s = Setup::new("MCP-03-probe")?.start().await?;
    add_server(&s, vec![secret("E2E_MCP_REQUIRE_SECRET", "E2E_NOT_SET")]).await?;
    let probed = probe(&s).await?;
    assert!(!healthy(&probed), "failing server probed healthy: {probed}");
    assert!(
        !probed
            .to_string()
            .contains(&butler_e2e::e2e::binary::mcp_fixture_binary(FIXTURE)),
        "probe leaks the command path: {probed}"
    );
    s.finish().await
}
