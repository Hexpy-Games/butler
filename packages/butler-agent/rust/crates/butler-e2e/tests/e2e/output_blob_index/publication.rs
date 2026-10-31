use super::*;

#[tokio::test]
async fn pruned_revision_blob_is_reclaimed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-PRUNE")?;
    schema(&setup.sandbox.data, false)?;
    seed(&setup.sandbox.data, "general", "keep", b"Shared", false)?;
    let s = setup.start().await?;
    completed(&s).await?;
    let owner = chat(&s).await?;
    std::fs::create_dir_all(s.sandbox.data.join("site"))?;
    let mut paths = Vec::new();
    for n in 0..6 {
        let body = format!("Revision {n}");
        std::fs::write(s.sandbox.data.join("site/index.html"), &body)?;
        std::fs::write(s.sandbox.data.join("site/shared.txt"), b"Shared")?;
        let (_, turn) = s.turn(&owner, "Again").await?;
        assert_eq!(turn["state"], "delivered");
        paths.push(
            s.sandbox
                .data
                .join("outputs/blobs")
                .join(&hash(body.as_bytes())[..2])
                .join(hash(body.as_bytes())),
        );
    }
    let unrelated = chat(&s).await?;
    delete(&s, &unrelated).await?;
    assert!(!paths[0].exists());
    for path in &paths[1..] {
        assert!(path.is_file(), "kept revision blob missing");
    }
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blobs")?,
        7
    );
    content(&s, &hash(b"general\0keep"), "Shared").await?;
    s.finish().await
}

#[tokio::test]
async fn manifest_is_never_persisted_before_blob_rows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-ORDER")?;
    schema(&setup.sandbox.data, true)?;
    seed(&setup.sandbox.data, "general", "old", b"Old", true)?;
    db(&setup.sandbox.data)?.execute_batch("CREATE TRIGGER reject_protection BEFORE INSERT ON output_blobs BEGIN SELECT RAISE(ABORT,'protection failed'); END;")?;
    let s = setup.start().await?;
    std::fs::create_dir_all(s.sandbox.data.join("site"))?;
    std::fs::write(s.sandbox.data.join("site/index.html"), b"New")?;
    s.turn("general", "Again").await?;
    let id = hash(b"general\0site");
    assert!(
        !s.sandbox
            .data
            .join(format!("outputs/manifests/{id}.json"))
            .exists(),
        "manifest committed without protected blob rows"
    );
    s.finish().await
}

#[tokio::test]
async fn completed_backfill_is_idle_for_sixty_seconds() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-IDLE")?;
    schema(&setup.sandbox.data, false)?;
    let id = seed(&setup.sandbox.data, "general", "live", b"Live", false)?;
    let s = setup.start().await?;
    completed(&s).await?;
    crate::memory_fixture::settle(&s.sandbox.data).await?;
    let index = db(&s.sandbox.data)?;
    let version: i64 = index.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    let mut watch =
        super::super::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    tokio::time::sleep(Duration::from_secs(60)).await;
    watch.assert_unchanged();
    assert_eq!(
        index.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))?,
        version
    );
    content(&s, &id, "Live").await?;
    eprintln!("BLOB-IDLE 60 seconds: 0 App/index commits, 0 file writes");
    drop(index);
    s.finish().await
}
