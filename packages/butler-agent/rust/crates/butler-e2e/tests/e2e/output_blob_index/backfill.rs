use super::*;

#[tokio::test]
async fn shared_blob_survives_delete_before_backfill() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-LEGACY-SHARED")?;
    schema(&setup.sandbox.data, false)?;
    block_completion(&setup.sandbox.data)?;
    db(&setup.sandbox.data)?.execute_batch("CREATE TRIGGER block_cursor BEFORE UPDATE OF cursor ON output_blob_backfill BEGIN SELECT RAISE(ABORT,'hold batch'); END;")?;
    let mut s = setup.start().await?;
    let old = chat(&s).await?;
    let new = chat(&s).await?;
    s.agent.terminate().await?;
    let old_id = seed(&s.sandbox.data, &old, "old", b"Shared", false)?;
    db(&s.sandbox.data)?
        .execute_batch("DELETE FROM output_blobs; DELETE FROM output_blob_backfill;")?;
    s.gw = s.agent.start_again().await?;
    // Publish through the public tool path while the old output has no rows.
    std::fs::create_dir_all(s.sandbox.data.join("site"))?;
    std::fs::write(s.sandbox.data.join("site/index.html"), b"Shared")?;
    let (_, turn) = s.turn(&new, "Again").await?;
    assert_eq!(turn["state"], "delivered");
    let path = blob(&s.sandbox.data, b"Shared")?;
    delete(&s, &new).await?;
    assert!(path.is_file(), "incomplete backfill deleted shared data");
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blob_sweep")?,
        1
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT complete FROM output_blob_backfill")?,
        0
    );
    // Releasing the triggers requires a restart; migration does not poll.
    db(&s.sandbox.data)?
        .execute_batch("DROP TRIGGER block_complete; DROP TRIGGER block_cursor;")?;
    s.restart().await?;
    completed(&s).await?;
    content(&s, &old_id, "Shared").await?;
    delete(&s, &old).await?;
    assert!(!path.exists());
    s.finish().await
}

#[tokio::test]
async fn unindexed_session_delete_reclaims_after_backfill() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-LEGACY-DELETE")?;
    schema(&setup.sandbox.data, false)?;
    // Abort the first batch: the session remains completely unindexed.
    db(&setup.sandbox.data)?.execute_batch("CREATE TRIGGER block_cursor BEFORE UPDATE OF cursor ON output_blob_backfill BEGIN SELECT RAISE(ABORT,'hold batch'); END;")?;
    let mut s = setup.start().await?;
    let owner = chat(&s).await?;
    s.agent.terminate().await?;
    seed(&s.sandbox.data, &owner, "delete", b"Unique", false)?;
    db(&s.sandbox.data)?.execute_batch("UPDATE output_blob_backfill SET complete=0,indexed=0;")?;
    s.gw = s.agent.start_again().await?;
    let path = blob(&s.sandbox.data, b"Unique")?;
    delete(&s, &owner).await?;
    assert!(path.exists());
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blob_sweep")?,
        1
    );
    db(&s.sandbox.data)?.execute_batch("DROP TRIGGER block_cursor;")?;
    s.restart().await?;
    completed(&s).await?;
    assert!(!path.exists(), "unindexed deleted session leaked its blob");
    s.finish().await
}

#[tokio::test]
async fn backfill_resumes_after_interruption() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-RESUME")?;
    schema(&setup.sandbox.data, false)?;
    for n in 0..600 {
        seed(
            &setup.sandbox.data,
            "general",
            &format!("{n:04}"),
            b"Shared",
            false,
        )?;
    }
    db(&setup.sandbox.data)?.execute_batch("CREATE TRIGGER interrupt_cursor BEFORE UPDATE OF cursor ON output_blob_backfill WHEN OLD.cursor<>'' BEGIN SELECT RAISE(ABORT,'interrupt'); END;")?;
    let mut s = setup.start().await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while scalar(&s.sandbox.data, "SELECT indexed FROM output_blob_backfill")? == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .map_err(|_| HarnessError("no batch committed".into()))??;
    s.agent.terminate().await?;
    let cursor: String =
        db(&s.sandbox.data)?
            .query_row("SELECT cursor FROM output_blob_backfill", [], |r| r.get(0))?;
    let indexed = scalar(&s.sandbox.data, "SELECT indexed FROM output_blob_backfill")?;
    assert!(indexed > 0 && indexed < 600);
    db(&s.sandbox.data)?.execute_batch(&format!("DROP TRIGGER interrupt_cursor;
        CREATE TRIGGER no_rewind BEFORE UPDATE OF cursor ON output_blob_backfill WHEN NEW.cursor<='{cursor}' BEGIN SELECT RAISE(ABORT,'cursor rewound'); END;"))?;
    s.gw = s.agent.start_again().await?;
    completed(&s).await?;
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blobs")?,
        600
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT indexed FROM output_blob_backfill")?,
        600
    );
    // An already-complete migration must not write its state, rows or queue.
    db(&s.sandbox.data)?.execute_batch("CREATE TRIGGER no_backfill_write BEFORE UPDATE ON output_blob_backfill BEGIN SELECT RAISE(ABORT,'unexpected backfill'); END;
        CREATE TRIGGER no_blob_insert BEFORE INSERT ON output_blobs BEGIN SELECT RAISE(ABORT,'unexpected insert'); END;")?;
    let log_before = s.agent.logs();
    s.restart().await?;
    completed(&s).await?;
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT indexed FROM output_blob_backfill")?,
        600
    );
    let log_after = s.agent.logs();
    assert_eq!(
        log_after.matches("output blob backfill finished").count(),
        log_before.matches("output blob backfill finished").count()
    );
    s.finish().await
}

#[tokio::test]
async fn orphan_blob_is_reclaimed_by_backfill() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-ORPHAN")?;
    schema(&setup.sandbox.data, false)?;
    let id = seed(&setup.sandbox.data, "general", "live", b"Live", false)?;
    let mut orphans = Vec::new();
    for n in 0..300 {
        orphans.push(blob(&setup.sandbox.data, format!("Orphan {n}").as_bytes())?);
    }
    std::fs::write(
        setup.sandbox.data.join("outputs/manifests/corrupt.json"),
        b"{",
    )?;
    let s = setup.start().await?;
    completed(&s).await?;
    for orphan in orphans {
        assert!(!orphan.exists());
    }
    content(&s, &id, "Live").await?;
    s.finish().await
}

#[tokio::test]
async fn unreadable_manifest_keeps_marker_unset_and_all_blobs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-IO")?;
    schema(&setup.sandbox.data, false)?;
    seed(&setup.sandbox.data, "general", "live", b"Live", false)?;
    let orphan = blob(&setup.sandbox.data, b"Orphan")?;
    let unreadable =
        Unreadable::directory(setup.sandbox.data.join("outputs/manifests/unreadable.json"))?;
    let mut s = setup.start().await?;
    // Wait for an observable production failure rather than racing the worker.
    tokio::time::timeout(Duration::from_secs(10), async {
        while !s.agent.logs().contains("output blob backfill failed") {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("missing migration I/O diagnostic".into()))?;
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT complete FROM output_blob_backfill")?,
        0
    );
    assert!(orphan.exists());
    drop(unreadable);
    std::fs::remove_dir(s.sandbox.data.join("outputs/manifests/unreadable.json"))?;
    s.restart().await?;
    completed(&s).await?;
    assert!(!orphan.exists());
    s.finish().await
}
