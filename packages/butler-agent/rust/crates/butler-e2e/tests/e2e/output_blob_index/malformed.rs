use super::*;

fn malformed_store(data: &Path) -> Result<(Vec<PathBuf>, Vec<PathBuf>), HarnessError> {
    schema(data, false)?;
    let dir = data.join("outputs/manifests");
    std::fs::create_dir_all(&dir)?;
    let mut blobs = Vec::new();
    let mut manifests = Vec::new();
    for (name, body, truncated) in [
        ("newer", b"Unknown shape".as_slice(), false),
        ("cut", b"Truncated".as_slice(), true),
    ] {
        blobs.push(blob(data, body)?);
        let path = dir.join(format!("{}.json", hash(name.as_bytes())));
        let sha = hash(body);
        let raw = if truncated {
            format!("{{\"files\":[\"{sha}\"],\"unfinished\":")
        } else {
            json!({"future_format":{"references":[sha]}}).to_string()
        };
        std::fs::write(&path, raw)?;
        manifests.push(path);
    }
    Ok((blobs, manifests))
}

#[tokio::test]
async fn unparseable_manifests_protect_visible_references() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-RAW-REFERENCES")?;
    let (blobs, manifests) = malformed_store(&setup.sandbox.data)?;
    let s = setup.start().await?;
    completed(&s).await?;
    for (blob, manifest) in blobs.iter().zip(&manifests) {
        assert!(blob.is_file(), "backfill deleted {}", blob.display());
        let rows: i64 = db(&s.sandbox.data)?.query_row(
            "SELECT count(*) FROM output_blobs WHERE output_id=?1 AND sha=?2",
            params![
                manifest.file_stem().unwrap().to_str(),
                blob.file_name().unwrap().to_str()
            ],
            |r| r.get(0),
        )?;
        assert_eq!(rows, 1, "raw reference must belong to the manifest stem");
    }
    let unrelated = chat(&s).await?;
    seed(&s.sandbox.data, &unrelated, "own", b"Unrelated", true)?;
    delete(&s, &unrelated).await?;
    for blob in blobs {
        assert!(blob.is_file(), "unrelated delete removed protected data");
    }
    s.finish().await
}

#[tokio::test]
async fn unparseable_manifests_skip_orphans_and_log_paths() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-RAW-ORPHAN")?;
    let (blobs, manifests) = malformed_store(&setup.sandbox.data)?;
    let orphan = blob(&setup.sandbox.data, b"Real orphan")?;
    let s = setup.start().await?;
    completed(&s).await?;
    assert!(
        orphan.is_file(),
        "uncertain ownership must skip orphan reclaim"
    );
    for path in blobs {
        assert!(path.is_file());
    }
    let logs = s.agent.logs();
    for path in manifests {
        assert!(
            logs.contains(&format!(
                "outputs/manifests/{}",
                path.file_name().unwrap().to_str().unwrap()
            )),
            "missing diagnostic: {logs}"
        );
    }
    assert!(
        logs.contains("orphan pass skipped"),
        "missing diagnostic: {logs}"
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT queued FROM output_blob_backfill")?,
        0
    );
    s.finish().await
}

#[tokio::test]
async fn interrupted_uncertain_backfill_still_skips_orphans() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-RAW-RESUME")?;
    let (blobs, _) = malformed_store(&setup.sandbox.data)?;
    let orphan = blob(&setup.sandbox.data, b"Real orphan")?;
    block_completion(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !s.agent.logs().contains("hold backfill") {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("completion interruption not observed".into()))?;
    s.agent.terminate().await?;
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blobs")?,
        2
    );
    db(&s.sandbox.data)?.execute_batch("DROP TRIGGER block_complete;")?;
    s.gw = s.agent.start_again().await?;
    completed(&s).await?;
    assert!(orphan.is_file(), "resume forgot uncertain ownership");
    for path in blobs {
        assert!(path.is_file());
    }
    s.finish().await
}
