use super::*;

#[tokio::test]
async fn normal_adopt_delete_and_archive() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("OWNER-NORMAL")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let old = chat(&s).await?;
    let target = chat(&s).await?;
    s.agent.terminate().await?;
    let id = seed(&s.sandbox.data, &old, "adopt", b"Normal", true)?;
    OutputStore::new(&s.sandbox.data).adopt(&id, &target, "parent-turn", "parent-message")?;
    assert!(!markers(&s.sandbox.data, &old).join(&id).exists());
    let own = seed(&s.sandbox.data, "general", "archive", b"Archive", true)?;
    s.gw = s.agent.start_again().await?;
    delete(&s, &old).await?;
    live_rows(&s.sandbox.data, &id, &target)?;
    content(&s, &id, "Normal").await?;
    let archived = archive(&s).await?;
    live_rows(&s.sandbox.data, &own, &archived)?;
    content(&s, &own, "Archive").await?;
    delete(&s, &target).await?;
    delete(&s, &archived).await?;
    assert_eq!(scalar(&s.sandbox.data, "SELECT count(*) FROM outputs")?, 0);
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_refs")?,
        0
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blobs")?,
        0
    );
    assert_eq!(
        std::fs::read_dir(s.sandbox.data.join("outputs/manifests"))?.count(),
        0
    );
    assert!(!blob_path(&s.sandbox.data, b"Normal").exists());
    assert!(!blob_path(&s.sandbox.data, b"Archive").exists());
    s.finish().await
}

async fn malformed(complete: bool, clear: bool) -> Result<(), HarnessError> {
    let setup = setup("OWNER-MALFORMED")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let session = if clear {
        "general".to_owned()
    } else {
        chat(&s).await?
    };
    s.agent.terminate().await?;
    let id = seed(&s.sandbox.data, &session, "malformed", b"Malformed", true)?;
    std::fs::write(manifest(&s.sandbox.data, &id), b"{")?;
    migration(&s.sandbox.data, complete)?;
    s.gw = s.agent.start_again().await?;
    let r = if clear {
        s.gw.post(
            "/sessions/general/clear",
            json!({"title":"Saved conversation"}),
        )
        .await?
    } else {
        s.gw.delete(&format!("/sessions/{session}?permanent=true"))
            .await?
    };
    // Existing semantics: archive and pre-migration delete require parsing.
    let kept = clear || !complete;
    assert_eq!(r.status, if kept { 500 } else { 200 }, "{r:?}");
    assert_eq!(manifest(&s.sandbox.data, &id).exists(), kept);
    assert_eq!(blob_path(&s.sandbox.data, b"Malformed").exists(), kept);
    s.finish().await
}
#[tokio::test]
async fn malformed_delete_migrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    malformed(true, false).await
}
#[tokio::test]
async fn malformed_delete_unmigrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    malformed(false, false).await
}
#[tokio::test]
async fn malformed_archive_migrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    malformed(true, true).await
}
#[tokio::test]
async fn malformed_archive_unmigrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    malformed(false, true).await
}

#[tokio::test]
async fn missing_manifest_replay_cleans_rows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for complete in [false, true] {
        let setup = setup("OWNER-MISSING")?;
        schema(&setup.sandbox.data, true)?;
        let mut s = setup.start().await?;
        let session = chat(&s).await?;
        s.agent.terminate().await?;
        let id = seed(&s.sandbox.data, &session, "missing", b"Missing", true)?;
        std::fs::remove_file(manifest(&s.sandbox.data, &id))?;
        migration(&s.sandbox.data, complete)?;
        s.gw = s.agent.start_again().await?;
        delete(&s, &session).await?;
        no_session_rows(&s.sandbox.data, &session)?;
        finish_migration(&mut s, complete).await?;
        assert!(!blob_path(&s.sandbox.data, b"Missing").exists());
        s.finish().await?;
    }
    Ok(())
}
