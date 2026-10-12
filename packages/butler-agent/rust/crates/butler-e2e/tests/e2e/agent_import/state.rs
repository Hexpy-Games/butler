//! Import state and credential waiting through the public App API.
use super::*;

/// Source state survives empty secrets; discovery waits and resumes after a key-only PATCH.
#[tokio::test]
async fn agent_import_mirrors_state_waits_for_keys_and_marks_tool_filters()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("AGENT-IMPORT-STATE")?.fixture(Fixture::Empty);
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let command = butler_e2e::e2e::binary::mcp_fixture_binary()?;
    let mut entries = serde_json::Map::new();
    for (name, enabled, key) in [
        ("on", true, false),
        ("off", false, false),
        ("waiting", true, true),
        ("off-key", false, true),
    ] {
        let mut entry = json!({"type":"local", "command":[command, name], "enabled":enabled});
        if key {
            entry["environment"] = json!({"E2E_SECRET":"source-value"});
            entry["headers"] = json!({"Authorization":"source-header"});
        }
        entries.insert(name.into(), entry);
    }
    write(
        &setup.sandbox.home,
        ".config/opencode/opencode.json",
        &json!({"mcp":entries}).to_string(),
    );
    write(
        &setup.sandbox.home,
        ".codex/config.toml",
        r#"
[mcp_servers.allowed]
command = "unused-allow"
enabled = true
enabled_tools = ["read"]
[mcp_servers.denied]
command = "unused-deny"
enabled = true
disabled_tools = ["write"]
[mcp_servers.codex-off]
command = "unused-codex-off"
enabled = false
[mcp_servers.empty-allow]
command = "unused-empty-allow"
enabled_tools = []
"#,
    );
    write(
        &setup.sandbox.home,
        ".hermes/config.yaml",
        "mcp_servers:\n  limited:\n    command: unused-hermes\n    tools:\n      include: [read]\n  hermes-off:\n    command: unused-hermes-off\n    enabled: false\n",
    );
    write(
        &setup.sandbox.home,
        ".claude.json",
        &json!({
            "mcpServers": {"claude-off": {"command":"unused-claude"}},
            "disabledMcpServers": ["claude-off"]
        })
        .to_string(),
    );
    let s = setup.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    assert_eq!(start(&admin, "opencode").await?["servers"], 4);
    assert_eq!(start(&admin, "codex").await?["servers"], 4);
    assert_eq!(start(&admin, "hermes").await?["servers"], 2);
    assert_eq!(start(&admin, "claude-code").await?["servers"], 1);
    let rows = servers(&s).await?;
    assert_eq!(server(&rows, "claude-off")["enabled"], false);
    for (id, enabled) in [
        ("on", true),
        ("off", false),
        ("waiting", true),
        ("off-key", false),
    ] {
        assert_eq!(server(&rows, id)["enabled"], enabled, "{id}");
    }
    for id in ["codex-off", "hermes-off"] {
        assert_eq!(server(&rows, id)["enabled"], false);
    }
    for id in ["allowed", "denied", "limited", "empty-allow"] {
        assert_eq!(server(&rows, id)["enabled"], false);
        assert_eq!(server(&rows, id)["tool_filter_review_required"], true);
    }
    let waiting = s.gw.post("/mcp-servers/waiting/probe", json!({})).await?;
    assert_eq!(waiting.data()["servers"][0]["ok"], false);
    assert_eq!(
        waiting.data()["servers"][0]["error"],
        "MCP server needs a key."
    );
    let ready = s.gw.get("/mcp-capabilities").await?;
    assert_eq!(
        server(ready.data()["servers"].as_array().unwrap(), "on")["ok"],
        true
    );
    assert_eq!(
        server(ready.data()["servers"].as_array().unwrap(), "waiting")["tools"],
        json!([])
    );
    let patch =
        s.gw.patch(
            "/mcp-servers/waiting",
            json!({"env":[
                {"key":"E2E_SECRET", "source":"literal", "value":"filled-value"},
                {"key":"E2E_MCP_REQUIRE_SECRET", "source":"literal", "value":"E2E_SECRET"}
            ]}),
        )
        .await?;
    assert_eq!(patch.status, 200);
    assert_eq!(patch.data()["server"]["enabled"], true);
    let waiting = s.gw.get("/mcp-capabilities").await?;
    assert_eq!(
        server(waiting.data()["servers"].as_array().unwrap(), "waiting")["ok"],
        false,
        "header slot still needs its key"
    );
    let patch =
        s.gw.patch(
            "/mcp-servers/waiting",
            json!({"headers":[
                {"key":"Authorization", "source":"literal", "value":"filled-header"}
            ]}),
        )
        .await?;
    assert_eq!(patch.status, 200);
    assert_eq!(patch.data()["server"]["enabled"], true);
    let ready = s.gw.get("/mcp-capabilities").await?;
    let row = server(ready.data()["servers"].as_array().unwrap(), "waiting");
    assert_eq!(row["ok"], true);
    assert_eq!(row["tools"][0]["name"], "e2e_echo");
    for id in [
        "off",
        "off-key",
        "allowed",
        "denied",
        "limited",
        "empty-allow",
        "claude-off",
        "codex-off",
        "hermes-off",
    ] {
        let row = server(ready.data()["servers"].as_array().unwrap(), id);
        assert_eq!(row["enabled"], false);
        assert_eq!(row["ok"], false);
        assert_eq!(row["tools"], json!([]));
        assert_eq!(row["error"], "MCP server is disabled.");
    }
    s.finish().await
}
