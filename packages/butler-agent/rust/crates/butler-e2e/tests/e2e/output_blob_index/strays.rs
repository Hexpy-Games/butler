use super::*;

async fn stray(kind: &str) -> Result<(), HarnessError> {
    let setup = setup(&format!("BLOB-STRAY-{kind}"))?;
    schema(&setup.sandbox.data, false)?;
    let id = seed(&setup.sandbox.data, "general", "live", b"Live", false)?;
    let orphan = blob(&setup.sandbox.data, b"Orphan")?;
    let path = match kind {
        "temp" => orphan
            .parent()
            .unwrap()
            .join(format!(".{}.123.1.42.tmp", hash(b"Temp"))),
        "directory" => {
            let sha = hash(b"Directory");
            setup
                .sandbox
                .data
                .join("outputs/blobs")
                .join(&sha[..2])
                .join(sha)
        }
        _ => setup.sandbox.data.join("outputs/blobs/plain"),
    };
    if kind == "directory" {
        std::fs::create_dir_all(&path)?;
    } else {
        std::fs::write(&path, b"Stray")?;
    }
    let s = setup.start().await?;
    completed(&s).await?;
    assert!(!orphan.exists());
    assert_eq!(path.exists(), kind != "temp");
    content(&s, &id, "Live").await?;
    delete(&s, &chat(&s).await?).await?;
    s.finish().await
}

#[tokio::test]
async fn temp_leftover_does_not_block_backfill() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    stray("temp").await
}
#[tokio::test]
async fn shard_directory_does_not_block_backfill() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    stray("directory").await
}
#[tokio::test]
async fn root_file_does_not_block_backfill() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    stray("file").await
}

#[tokio::test]
async fn failed_unlink_keeps_debt_and_advances_past_page() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-UNLINK")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let owner = chat(&s).await?;
    let id = seed(&s.sandbox.data, &owner, "blocked", b"Blocked", true)?;
    let sha = hash(b"Blocked");
    let blocked = blob(&s.sandbox.data, b"Blocked")?;
    std::fs::remove_file(&blocked)?;
    std::fs::create_dir(&blocked)?;
    std::fs::write(blocked.join("obstacle"), b"keep")?;
    // Every first-page row fails. A cursor must still reach the next page.
    let mut db = db(&s.sandbox.data)?;
    let tx = db.transaction()?;
    let mut later = Vec::new();
    for n in 0..260 {
        let key = format!("{n:064x}");
        let path = s
            .sandbox
            .data
            .join("outputs/blobs")
            .join(&key[..2])
            .join(&key);
        std::fs::create_dir_all(path.parent().unwrap())?;
        if n < 128 {
            std::fs::create_dir(&path)?;
        } else {
            std::fs::write(&path, b"orphan")?;
            later.push(path);
        }
        tx.execute("INSERT INTO output_blob_sweep VALUES(?1)", [&key])?;
    }
    tx.commit()?;
    delete(&s, &owner).await?;
    assert!(
        !s.sandbox
            .data
            .join(format!("outputs/manifests/{id}.json"))
            .exists()
    );
    assert_eq!(
        scalar(
            &s.sandbox.data,
            &format!("SELECT count(*) FROM output_blob_sweep WHERE sha='{sha}'")
        )?,
        1
    );
    // One request is bounded; startup resumes the remaining queue.
    s.restart().await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while later.iter().any(|p| p.exists()) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("later queue pages were blocked".into()))?;
    assert_eq!(
        scalar(
            &s.sandbox.data,
            &format!("SELECT count(*) FROM output_blob_sweep WHERE sha='{sha}'")
        )?,
        1
    );
    std::fs::remove_dir_all(&blocked)?;
    std::fs::write(&blocked, b"Blocked")?;
    for n in 0..128 {
        let key = format!("{n:064x}");
        std::fs::remove_dir(
            s.sandbox
                .data
                .join("outputs/blobs")
                .join(&key[..2])
                .join(key),
        )?;
    }
    s.restart().await?;
    completed(&s).await?;
    assert!(!blocked.exists());
    s.finish().await
}

#[tokio::test]
async fn invalid_queued_names_are_cleared_without_filesystem_access() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-INVALID-QUEUE")?;
    schema(&setup.sandbox.data, true)?;
    let s = setup.start().await?;
    let sentinel = s.sandbox.data.join("outputs/blobs/.invalid.tmp");
    std::fs::create_dir_all(sentinel.parent().unwrap())?;
    std::fs::write(&sentinel, b"keep")?;
    db(&s.sandbox.data)?
        .execute_batch("INSERT INTO output_blob_sweep VALUES('.invalid.tmp'),('');")?;
    delete(&s, &chat(&s).await?).await?;
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blob_sweep")?,
        0
    );
    assert_eq!(std::fs::read(sentinel)?, b"keep");
    s.finish().await
}
