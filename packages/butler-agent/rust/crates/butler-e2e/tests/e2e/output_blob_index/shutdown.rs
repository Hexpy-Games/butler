use super::*;
use std::time::Instant;

// Large on-disk legacy store, without paying one SQLite transaction per fixture.
pub(super) fn legacy_manifests(data: &Path, count: usize) -> Result<(), HarnessError> {
    let dir = data.join("outputs/manifests");
    std::fs::create_dir_all(&dir)?;
    for n in 0..count {
        let id = hash(format!("legacy-{n}").as_bytes());
        let files: serde_json::Map<String, serde_json::Value> = (0..4)
            .map(|file| {
                (
                    format!("{file}.txt"),
                    json!(hash(format!("{n}-{file}").as_bytes())),
                )
            })
            .collect();
        std::fs::write(
            dir.join(format!("{id}.json")),
            serde_json::to_vec(&json!({
                "kind":"file", "output_id":id, "session_id":"general", "message_id":id,
                "turn_id":id, "title":"Legacy", "revisions":[{"revision":1,
                    "entry":"0.txt", "files":files, "size_bytes":4,
                    "created_at":"2026-01-01T00:00:00Z"}]
            }))?,
        )?;
    }
    Ok(())
}

#[tokio::test]
async fn stop_during_backfill_preserves_cursor_and_resumes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-STOP")?;
    schema(&setup.sandbox.data, false)?;
    legacy_manifests(&setup.sandbox.data, 100_000)?;
    let index = setup.sandbox.data.join("outputs/index.sqlite");
    let initial_bytes = std::fs::metadata(&index)?.len();
    let mut s = setup.start().await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while std::fs::metadata(&index)?.len() == initial_bytes {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .map_err(|_| HarnessError("backfill never started".into()))??;
    let stop = Instant::now();
    s.agent.terminate().await?;
    let stop_elapsed = stop.elapsed();
    assert!(
        !s.agent.logs().contains("stop deadline reached"),
        "backfill required forced exit: {}",
        s.agent.logs()
    );
    butler_e2e::assert_wall_clock_budget!(
        stop_elapsed,
        Duration::from_secs(8),
        "normal stop deadline"
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT complete FROM output_blob_backfill")?,
        0
    );
    let indexed = scalar(&s.sandbox.data, "SELECT indexed FROM output_blob_backfill")?;
    assert!(
        indexed > 0 && indexed < 100_000,
        "worker did not stop between batches: {indexed}"
    );
    let cursor: String =
        db(&s.sandbox.data)?
            .query_row("SELECT cursor FROM output_blob_backfill", [], |r| r.get(0))?;
    db(&s.sandbox.data)?.execute_batch(&format!("CREATE TRIGGER no_rewind BEFORE UPDATE OF cursor ON output_blob_backfill WHEN NEW.cursor<='{cursor}' BEGIN SELECT RAISE(ABORT,'cursor rewound'); END;"))?;
    s.gw = s.agent.start_again().await?;
    wait_for_completion(&s, Duration::from_secs(120)).await?;
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT indexed FROM output_blob_backfill")?,
        100_000
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blobs")?,
        400_000
    );
    eprintln!(
        "BLOB-STOP indexed_at_stop={indexed} stop_ms={:.3}",
        stop_elapsed.as_secs_f64() * 1000.0
    );
    s.finish().await
}
