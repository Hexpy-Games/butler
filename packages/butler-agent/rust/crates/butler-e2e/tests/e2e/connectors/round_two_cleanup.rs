use super::*;

#[tokio::test]
async fn round_two_unavailable_keychain_does_not_block_uninstall() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unavailable_removal(true).await
}
#[tokio::test]
async fn round_two_unavailable_keychain_does_not_block_disconnect() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unavailable_removal(false).await
}
async fn unavailable_removal(uninstall: bool) -> Result<(), HarnessError> {
    let setup = setup("PC2-CLEANUP")?;
    let root = package(&setup.sandbox.home, false)?;
    let mut s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    // Restart the scenario after making only its fixture store unreachable.
    s.agent.terminate().await?;
    butler_platform::secrets::make_system_keychain_unavailable_for_test(&s.sandbox.home)?;
    s.restart().await?;
    let path = if uninstall {
        format!("/plugins/source?revision={}", revision(&s).await?)
    } else {
        format!(
            "/connectors/source/items/accounts/{id}?revision={}",
            revision(&s).await?
        )
    };
    let r = api(&s, Method::DELETE, &path, None).await?;
    assert_eq!(
        r.status, 200,
        "removal must succeed without credential store: {r:?}"
    );
    assert_eq!(r.data()["code"], "connector_secret_cleanup_pending");
    assert_eq!(
        r.data()["leftover_secrets"],
        json!([{"key":format!("source/items/{id}/ACCESS_KEY")}])
    );
    let registry: Value =
        serde_json::from_slice(&fs::read(s.sandbox.data.join("plugins/registry.json"))?)?;
    if uninstall {
        assert!(registry["plugins"]["source"].is_null());
    } else {
        assert_eq!(registry["accounts"][&id]["enabled"], false);
    }
    let records = cleanup_records(&s)?;
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0]["attrs"]["keys"],
        json!([format!("source/items/{id}/ACCESS_KEY")])
    );
    assert!(!records[0].to_string().contains("connector-private-value"));
    assert!(!r.text.contains("connector-private-value"));
    s.finish().await
}

fn cleanup_records(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let mut records = Vec::new();
    for entry in fs::read_dir(s.sandbox.data.join("logs/agent/main"))? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "jsonl") {
            for line in fs::read_to_string(path)?.lines() {
                let row: Value = serde_json::from_str(line)?;
                if row["event"] == "connector_secret_cleanup_pending" {
                    records.push(row);
                }
            }
        }
    }
    Ok(records)
}
