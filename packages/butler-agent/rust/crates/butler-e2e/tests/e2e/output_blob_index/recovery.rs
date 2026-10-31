use super::*;

async fn pending_transfer(dangling: bool) -> Result<(), HarnessError> {
    let setup = setup(if dangling {
        "BLOB-DANGLING"
    } else {
        "BLOB-EMPTY-INDEX"
    })?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let archive =
        s.gw.post("/sessions/general/clear", json!({"title":"Saved"}))
            .await?;
    assert_eq!(archive.status, 200, "{archive:?}");
    let archive = archive.data()["archived_session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.agent.terminate().await?;
    let app = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    app.execute("INSERT INTO app_output_transfers VALUES(?1)", [&archive])?;
    app.execute(
        "INSERT INTO app_session_context_gate VALUES('general','relocate',?1)",
        [&archive],
    )?;
    let id = if dangling {
        let id = seed(&s.sandbox.data, "general", "kept", b"Live", true)?;
        let markers = s
            .sandbox
            .data
            .join("outputs/sessions")
            .join(hash(b"general"));
        std::fs::write(markers.join(hash(b"missing manifest")), [])?;
        Some(id)
    } else {
        db(&s.sandbox.data)?.execute_batch("DROP TABLE outputs; DROP TABLE output_refs;")?;
        None
    };
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        app.query_row("SELECT count(*) FROM app_output_transfers", [], |r| r
            .get::<_, i64>(0))?,
        0
    );
    assert_eq!(
        app.query_row("SELECT count(*) FROM app_session_context_gate", [], |r| r
            .get::<_, i64>(
            0
        ))?,
        0
    );
    assert_eq!(
        s.gw.get("/artifacts?session_id=general").await?.data()["artifacts"],
        json!([])
    );
    let listing =
        s.gw.get(&format!("/artifacts?session_id={archive}"))
            .await?;
    assert_eq!(listing.status, 200, "{listing:?}");
    if let Some(id) = id {
        assert!(listing.text.contains(&id));
        content(&s, &id, "Live").await?;
    } else {
        assert_eq!(listing.data()["artifacts"], json!([]));
        // First successful publication still creates the projection normally.
        s.turn("general", "Publish").await?;
        assert!(
            !s.gw.get("/artifacts?session_id=general").await?.data()["artifacts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    drop(app);
    s.finish().await
}

#[tokio::test]
async fn dangling_marker_does_not_block_pending_clear() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    pending_transfer(true).await
}
#[tokio::test]
async fn blob_only_index_does_not_block_pending_clear() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    pending_transfer(false).await
}
