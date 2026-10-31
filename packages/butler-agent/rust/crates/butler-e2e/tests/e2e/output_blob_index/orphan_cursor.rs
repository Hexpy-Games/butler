use super::*;
use std::time::Instant;

#[tokio::test]
async fn orphan_pass_resumes_after_last_completed_shard() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-ORPHAN-CURSOR")?;
    schema(&setup.sandbox.data, false)?;
    let id = seed(&setup.sandbox.data, "general", "live", b"Live", false)?;
    let mut orphans = Vec::new();
    for shard in ["00", "80", "ff"] {
        for n in 0..260 {
            let sha = format!("{shard}{n:062x}");
            let path = setup
                .sandbox
                .data
                .join("outputs/blobs")
                .join(shard)
                .join(sha);
            std::fs::create_dir_all(path.parent().unwrap())?;
            std::fs::write(&path, b"orphan")?;
            orphans.push(path);
        }
    }
    db(&setup.sandbox.data)?.execute_batch("CREATE TRIGGER interrupt_orphans BEFORE INSERT ON output_blob_sweep WHEN substr(NEW.sha,1,2)='80' BEGIN SELECT RAISE(ABORT,'interrupt orphan shard'); END;")?;
    let mut s = setup.start().await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !s.agent.logs().contains("interrupt orphan shard") {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("orphan interruption not observed".into()))?;
    s.agent.terminate().await?;
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT complete FROM output_blob_backfill")?,
        0
    );
    let cursor: String = db(&s.sandbox.data)?.query_row(
        "SELECT orphan_cursor FROM output_blob_backfill",
        [],
        |r| r.get(0),
    )?;
    assert!(
        cursor.as_str() >= "00" && cursor.as_str() < "80",
        "{cursor}"
    );
    db(&s.sandbox.data)?.execute_batch(&format!("DROP TRIGGER interrupt_orphans;
        CREATE TRIGGER no_orphan_rewind BEFORE UPDATE OF orphan_cursor ON output_blob_backfill WHEN NEW.orphan_cursor<='{cursor}' BEGIN SELECT RAISE(ABORT,'orphan cursor rewound'); END;
        CREATE TRIGGER no_rescan BEFORE INSERT ON output_blob_sweep WHEN substr(NEW.sha,1,2)='00' BEGIN SELECT RAISE(ABORT,'completed shard rescanned'); END;"))?;
    s.gw = s.agent.start_again().await?;
    completed(&s).await?;
    let next: String = db(&s.sandbox.data)?.query_row(
        "SELECT orphan_cursor FROM output_blob_backfill",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(next, "ff");
    assert!(next > cursor);
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT queued FROM output_blob_backfill")?,
        780
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blobs")?,
        1
    );
    for path in orphans {
        assert!(!path.exists(), "{}", path.display());
    }
    content(&s, &id, "Live").await?;
    s.finish().await
}

#[tokio::test]
async fn stop_during_orphan_pass_keeps_committed_shard_cursor() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-ORPHAN-STOP")?;
    schema(&setup.sandbox.data, false)?;
    let id = seed(&setup.sandbox.data, "general", "live", b"Live", false)?;
    let mut orphans = Vec::new();
    // 16 shards keep the restart's completion inside this test's hang watchdog.
    // That wait is background work after readiness, not a user wait; the
    // 256-shard stop is asserted separately below.
    for shard in (0..=255).step_by(17) {
        let dir = setup
            .sandbox
            .data
            .join(format!("outputs/blobs/{shard:02x}"));
        std::fs::create_dir_all(&dir)?;
        for n in 0..512 {
            let path = dir.join(format!("{shard:02x}{n:062x}"));
            std::fs::write(&path, [])?;
            orphans.push(path);
        }
    }
    // Keep the pass observable even when every fixture file lives on tmpfs.
    db(&setup.sandbox.data)?.execute_batch(
        "CREATE TRIGGER slow_orphans BEFORE INSERT ON output_blob_sweep BEGIN
           SELECT (WITH RECURSIVE burn(n) AS (
             VALUES(0) UNION ALL SELECT n+1 FROM burn WHERE n<10000
           ) SELECT sum(n) FROM burn);
         END;",
    )?;
    let mut s = setup.start().await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if observe_scalar(&s.sandbox.data,
                "SELECT complete=0 AND orphan_cursor<>'' AND queued>=512 FROM output_blob_backfill WHERE id=1").await? == Some(1) {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.map_err(|_| HarnessError("no active orphan pass observed".into()))??;
    s.agent.terminate().await?;
    assert!(!s.agent.logs().contains("stop deadline reached"));
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT complete FROM output_blob_backfill")?,
        0
    );
    let cursor: String = db(&s.sandbox.data)?.query_row(
        "SELECT orphan_cursor FROM output_blob_backfill",
        [],
        |r| r.get(0),
    )?;
    assert!(!cursor.is_empty() && cursor.as_str() < "ff", "{cursor}");
    db(&s.sandbox.data)?.execute_batch(&format!("DROP TRIGGER slow_orphans;
        CREATE TRIGGER no_rewind BEFORE UPDATE OF orphan_cursor ON output_blob_backfill WHEN NEW.orphan_cursor<='{cursor}' BEGIN SELECT RAISE(ABORT,'orphan cursor rewound'); END;"))?;
    s.gw = s.agent.start_again().await?;
    completed(&s).await?;
    let next: String = db(&s.sandbox.data)?.query_row(
        "SELECT orphan_cursor FROM output_blob_backfill",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(next, "ff");
    assert!(next > cursor);
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT queued FROM output_blob_backfill")?,
        8_192
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blobs")?,
        1
    );
    for path in orphans {
        assert!(!path.exists(), "{}", path.display());
    }
    content(&s, &id, "Live").await?;
    s.finish().await
}

#[tokio::test]
async fn stop_during_orphan_pass_across_all_shards_is_prompt() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-ORPHAN-STOP-ALL-SHARDS")?;
    schema(&setup.sandbox.data, false)?;
    seed(&setup.sandbox.data, "general", "live", b"Live", false)?;
    for shard in 0..=255 {
        let dir = setup
            .sandbox
            .data
            .join(format!("outputs/blobs/{shard:02x}"));
        std::fs::create_dir_all(&dir)?;
        for n in 0..32 {
            std::fs::write(dir.join(format!("{shard:02x}{n:062x}")), [])?;
        }
    }
    // Keep the pass observable even when every fixture file lives on tmpfs.
    db(&setup.sandbox.data)?.execute_batch(
        "CREATE TRIGGER slow_orphans BEFORE INSERT ON output_blob_sweep BEGIN
           SELECT (WITH RECURSIVE burn(n) AS (
             VALUES(0) UNION ALL SELECT n+1 FROM burn WHERE n<10000
           ) SELECT sum(n) FROM burn);
         END;",
    )?;
    let mut s = setup.start().await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if observe_scalar(
                &s.sandbox.data,
                "SELECT complete=0 AND orphan_cursor<>'' FROM output_blob_backfill WHERE id=1",
            )
            .await?
                == Some(1)
            {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("no active orphan pass observed".into()))??;
    let stop = Instant::now();
    s.agent.terminate().await?;
    let elapsed = stop.elapsed();
    assert!(
        !s.agent.logs().contains("stop deadline reached"),
        "orphan pass required forced exit: {}",
        s.agent.logs()
    );
    butler_e2e::assert_wall_clock_budget!(elapsed, Duration::from_secs(8), "normal stop deadline");
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT complete FROM output_blob_backfill")?,
        0
    );
    let cursor: String = db(&s.sandbox.data)?.query_row(
        "SELECT orphan_cursor FROM output_blob_backfill",
        [],
        |r| r.get(0),
    )?;
    assert!(!cursor.is_empty() && cursor.as_str() < "ff", "{cursor}");
    eprintln!(
        "BLOB-ORPHAN-STOP-ALL-SHARDS cursor={cursor} stop_ms={:.3}",
        elapsed.as_secs_f64() * 1000.0
    );
    s.finish().await
}
