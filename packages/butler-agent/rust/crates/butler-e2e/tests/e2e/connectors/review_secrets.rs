use super::*;

#[tokio::test]
async fn review_connect_refuses_unavailable_system_store_without_fallback()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    // No isolated keychain is prepared; the connector must fail closed.
    let setup = Setup::new("PC-NO-STORE")?.stub_cassette(Cassette::load("TOOL-01")?);
    let absent = setup.sandbox.home.join("unavailable/store.json");
    let setup = setup.env("BUTLER_TEST_SECRET_STORE", absent.to_string_lossy());
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let r=api(&s,Method::POST,"/connectors/source/items/accounts",Some(json!({"fields":{"address":"account@example.test"},"secrets":{"ACCESS_KEY":"connector-private-value"},"revision":revision(&s).await?}))).await?;
    assert_eq!(
        r.status, 400,
        "connector connect must refuse an unavailable system store"
    );
    assert!(r.text.contains("connector_secret_store_unavailable"));
    assert!(!s.sandbox.data.join("secrets/plugins.json").exists());
    s.finish().await
}

#[tokio::test]
async fn review_disconnect_and_uninstall_remove_connector_secrets() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for remove_data in [false, true] {
        let setup = setup("PC-SECRET-CLEANUP")?;
        let root = package(&setup.sandbox.home, false)?;
        let mut s = setup.start().await?;
        assert_eq!(
            s.agent
                .cli(&["config", "set", "secrets.store", "system", "--json"])?
                .code,
            Some(0)
        );
        s.restart().await?;
        install(&s, &root).await?;
        let first = connect(&s, "immediate", 10.0).await?;
        let second = connect(&s, "immediate", 10.0).await?;
        let present = |id: &str| -> Result<bool, HarnessError> {
            let key = butler_platform::secrets::SecretKey::new(
                "io.github.hexpy-games.butler.plugins",
                &format!("source/items/{id}/ACCESS_KEY"),
            )
            .unwrap();
            Ok(
                butler_platform::secrets::isolated_system_secret_present_for_test(
                    &s.sandbox.home,
                    &key,
                )?,
            )
        };
        assert!(
            present(&first)? && present(&second)?,
            "connector secrets were not written to the system keychain"
        );
        let r = api(
            &s,
            Method::DELETE,
            &format!(
                "/connectors/source/items/accounts/{first}?revision={}",
                revision(&s).await?
            ),
            None,
        )
        .await?;
        assert_eq!(r.status, 200, "{r:?}");
        assert_eq!(r.data()["leftover_secrets"], json!([]));
        assert!(!present(&first)?, "disconnect retained secret");
        let r = api(
            &s,
            Method::DELETE,
            &format!(
                "/plugins/source?revision={}&data={remove_data}",
                revision(&s).await?
            ),
            None,
        )
        .await?;
        assert_eq!(r.status, 200, "{r:?}");
        assert_eq!(r.data()["leftover_secrets"], json!([]));
        assert!(!present(&second)?, "uninstall retained secret");
        assert!(!s.sandbox.data.join("secrets/plugins.json").exists());
        s.finish().await?;
    }
    Ok(())
}
