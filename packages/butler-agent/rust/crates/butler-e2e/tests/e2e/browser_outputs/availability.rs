//! Browser routes and output tools are always part of the product.
use super::*;

#[tokio::test]
async fn browser_routes_and_output_tools_are_available() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-AVAILABLE")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    // Host registration still requires the local admin credential.
    assert_eq!(s.gw.get("/internal/browser-host").await?.status, 403);
    let (turn, _) = s.turn("general", "Tools").await?;
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
            assert!(items.iter().any(|item| item["name"] == name), "{value}");
        }
    }
    drop(db);
    s.finish().await
}
