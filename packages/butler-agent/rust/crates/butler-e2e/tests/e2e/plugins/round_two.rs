use super::*;
#[tokio::test]
async fn round_two_plugin_secrets_require_system_store_without_file_fallback()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG2-NO-STORE")?;
    let absent = setup.sandbox.home.join("absent/store.json");
    let setup = setup.env("BUTLER_TEST_SECRET_STORE", absent.to_string_lossy());
    let root = package(&setup.sandbox.home, "private-helper")?;
    fs::write(root.join("mcp.json"), json!({"mcpServers":{"notes":{"command":"${BUTLER_PLUGIN_ROOT}/server.exe","env":{"PRIVATE_TOKEN":"${PRIVATE_TOKEN}"}}}}).to_string())?;
    let s = setup.start().await?;
    let i = inspect(&s, &root).await?;
    let secret = format!("private-{}", uuid::Uuid::new_v4());
    let r = api(&s, Method::POST, "/plugins/install", Some(json!({"staging_id":i["staging_id"],"digest":i["digest"],"revision":revision(&s).await?,"secrets":{"PRIVATE_TOKEN":secret}}))).await?;
    assert_eq!(
        r.status, 400,
        "install must refuse unavailable credential store"
    );
    assert_eq!(r.error_code(), Some("plugin_secret_store_unavailable"));
    assert_eq!(
        api(&s, Method::GET, "/plugins", None).await?.data()["plugins"],
        json!([])
    );
    assert!(!s.sandbox.data.join("secrets/plugins.json").exists());
    assert_no_secret(&s.sandbox.data, secret.as_bytes())?;
    s.finish().await
}
fn assert_no_secret(path: &Path, secret: &[u8]) -> Result<(), HarnessError> {
    for entry in fs::read_dir(path)? {
        let path = entry?.path();
        if path.is_dir() {
            assert_no_secret(&path, secret)?;
        } else {
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                // Only a file a live database has byte-range locked (its WAL
                // index, a table of page numbers) is skipped, and only where
                // the host refuses the read; every other file is scanned.
                Err(error)
                    if butler_platform::host_file_behavior::is_byte_range_lock_conflict(&error) =>
                {
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            assert!(
                !bytes.windows(secret.len()).any(|w| w == secret),
                "secret was written to BUTLER_DATA"
            );
        }
    }
    Ok(())
}
