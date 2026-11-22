//! H. MCP servers (SCENARIOS.md MCP-01..05) with the stdio fixture server
//! `src/bin/e2e-mcp-fixture.rs`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::fake_servers::FakeServer;
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, nonce};
use serde_json::{Value, json};

pub(super) const PROMPT: &str =
    "Call the e2e_echo tool of the MCP server named e2e and tell me the token it returns.";

fn secret(key: &str, value: &str) -> Value {
    json!({"key": key, "source": "literal", "value": value})
}

pub(super) async fn add_server(s: &Scenario, env: Vec<Value>) -> Result<Value, HarnessError> {
    let reply = s
        .gw
        .post(
            "/mcp-servers",
            json!({"id": "e2e", "display_name": "E2E fixture", "enabled": true, "transport": "stdio",
                   "command": butler_e2e::e2e::binary::mcp_fixture_binary()?, "args": [], "env": env}),
        )
        .await?;
    assert!(reply.status < 300, "add server: {}", reply.text);
    Ok(reply.data().clone())
}

pub(super) async fn probe(s: &Scenario) -> Result<Value, HarnessError> {
    let reply = s.gw.post("/mcp-servers/e2e/probe", json!({})).await?;
    Ok(reply.body)
}

pub(super) fn healthy(probe: &Value) -> bool {
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
        !probed.to_string().contains(
            butler_e2e::e2e::binary::mcp_fixture_binary()?
                .to_str()
                .unwrap()
        ),
        "probe leaks the command path: {probed}"
    );
    s.finish().await
}

/// MCP-04 — Save failures retain per-cause codes over the public HTTP boundary.
#[tokio::test]
async fn mcp_04_save_error_codes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("MCP-04")?.start().await?;
    for (input, code) in [
        (json!({"id": ""}), "mcp_server_id_required"),
        (
            json!({"id": "missing-command", "transport": "stdio"}),
            "mcp_command_required",
        ),
        (
            json!({"id": "missing-http-url", "transport": "http"}),
            "mcp_url_required",
        ),
        (
            json!({"id": "missing-sse-url", "transport": "sse"}),
            "mcp_url_required",
        ),
    ] {
        let reply = s.gw.post("/mcp-servers", input).await?;
        assert_eq!(reply.status, 400, "{reply:?}");
        assert_eq!(reply.body["error"]["code"], code);
    }
    let created =
        s.gw.post("/mcp-servers", json!({"id": "valid", "command": "unused"}))
            .await?;
    assert_eq!(created.status, 201);
    for (input, code) in [
        (json!({"command": ""}), "mcp_command_required"),
        (json!({"transport": "http", "url": ""}), "mcp_url_required"),
        (json!({"transport": "sse", "url": ""}), "mcp_url_required"),
    ] {
        let reply = s.gw.patch("/mcp-servers/valid", input).await?;
        assert_eq!(reply.status, 400);
        assert_eq!(reply.body["error"]["code"], code);
    }
    let missing =
        s.gw.patch("/mcp-servers/removed", json!({"command": "unused"}))
            .await?;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.body["error"]["code"], "mcp_server_not_found");
    s.finish().await
}

/// MCP-05 — Typed header secrets live in the credential store, not the registry.
#[tokio::test]
async fn mcp_05_typed_secrets_leave_the_registry() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mcp = FakeServer::mcp_http().await?;
    let old = format!("e2e-old-{}", uuid::Uuid::new_v4().simple());
    let new = format!("e2e-new-{}", uuid::Uuid::new_v4().simple());
    let setup = Setup::new("MCP-05")?;
    let registry = setup.sandbox.data.join("config/mcp-servers.json");
    std::fs::create_dir_all(setup.sandbox.data.join("config"))?;
    std::fs::write(
        &registry,
        serde_json::to_vec(&json!({
            "version": 1,
            "servers": [{
                "id": "legacy", "display_name": "Legacy", "enabled": true, "transport": "http",
                "url": format!("{}/mcp", mcp.base_url), "args": [], "env": [],
                "headers": [{"key": "Authorization", "source": "literal", "value": format!("Bearer {old}")}],
                "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z"
            }]
        }))?,
    )?;
    let s = setup.start().await?;
    assert!(!std::fs::read_to_string(&registry)?.contains(&old));
    let probed = s.gw.post("/mcp-servers/legacy/probe", json!({})).await?;
    assert!(
        probed.body["data"]["servers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|server| server["id"] == "legacy" && server["ok"] == true)
    );
    assert!(mcp.seen().iter().any(|request| {
        request
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            == Some(format!("Bearer {old}").as_str())
    }));
    let added = s.gw.post("/mcp-servers", json!({
        "id": "e2e", "transport": "http", "url": format!("{}/mcp", mcp.base_url),
        "headers": [{"key": "Authorization", "source": "literal", "value": format!("Bearer {new}")}]
    })).await?;
    assert!(added.status < 300);
    let text = std::fs::read_to_string(&registry)?;
    assert!(!text.contains(&new) && !text.contains(&old));
    let probed = s.gw.post("/mcp-servers/e2e/probe", json!({})).await?;
    assert!(
        probed.body["data"]["servers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|server| server["id"] == "e2e" && server["ok"] == true)
    );
    assert!(mcp.seen().iter().any(|request| {
        request
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            == Some(format!("Bearer {new}").as_str())
    }));
    s.finish().await
}
