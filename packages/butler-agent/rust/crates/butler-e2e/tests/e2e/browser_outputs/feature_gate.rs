//! The same public stub contract runs against default-on and gate-off binaries.
use super::*;

#[tokio::test]
async fn browser_product_gate_controls_routes_and_model_tools() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let enabled = std::env::var("BUTLER_E2E_EXPECT_BROWSER").as_deref() != Ok("false");
    let s = Setup::new("BROWSER-PRODUCT-GATE")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    // Without an admin credential, the enabled host rejects admission. An off
    // build has no route, even when a client attempts to register a host.
    assert_eq!(
        s.gw.get("/internal/browser-host").await?.status,
        if enabled { 403 } else { 404 }
    );
    if !enabled {
        for path in [
            "/internal/browser/calls",
            "/internal/browser-host/results/forged",
        ] {
            assert_eq!(s.gw.post(path, json!({})).await?.status, 404);
        }
        assert_eq!(
            s.gw.get(&format!("/outputs/{}/view", "a".repeat(64)))
                .await?
                .status,
            404
        );
        let content = s.agent.launch.port + 1;
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", content))
                .await
                .is_err()
        );
    }
    let (turn, _) = s.turn("general", "Feature gate").await?;
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    for (tool, key) in [
        ("tool_search", "results"),
        ("tool_describe", "descriptions"),
    ] {
        let raw: String = db.query_row(
            "SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name=?2",
            [turn.as_str(), tool],
            |row| row.get(0),
        )?;
        let value: Value = serde_json::from_str(&raw)?;
        let items = value[key].as_array().unwrap();
        for name in ["output_publish", "output_check"] {
            assert_eq!(
                items.iter().any(|item| item["name"] == name),
                enabled,
                "{value}"
            );
        }
        if !enabled && tool == "tool_describe" {
            assert_eq!(value["missing"].as_array().unwrap().len(), 2);
        }
    }
    for request in s.provider()?.requests() {
        let tools = request["tools"].as_array().unwrap();
        if !enabled {
            assert!(tools.iter().all(|tool| {
                ["output_publish", "output_check"]
                    .iter()
                    .all(|name| tool["name"] != *name && tool["function"]["name"] != *name)
            }));
        }
    }
    drop(db);
    s.finish().await
}
