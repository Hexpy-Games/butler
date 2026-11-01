use super::super::output_blob_index::Unreadable;
use super::*;

async fn unreadable_delete(stale: bool) -> Result<(), HarnessError> {
    let setup = setup("OWNER-DELETE-IO")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let source = chat(&s).await?;
    let parent = chat(&s).await?;
    s.agent.terminate().await?;
    let first = seed(&s.sandbox.data, &source, "one", b"First", true)?;
    let second = seed(&s.sandbox.data, &source, "two", b"Second", true)?;
    let (own, blocked, body) = if first < second {
        (first, second, "Second")
    } else {
        (second, first, "First")
    };
    if stale {
        interrupted_move(&s.sandbox.data, &blocked, &parent, true)?;
    }
    let path = manifest(&s.sandbox.data, &blocked);
    let bytes = std::fs::read(&path)?;
    std::fs::remove_file(&path)?;
    let unreadable = Unreadable::directory(path.clone())?;
    s.gw = s.agent.start_again().await?;
    let reply =
        s.gw.delete(&format!("/sessions/{source}?permanent=true"))
            .await?;
    assert_eq!(reply.status, 500, "{reply:?}");
    assert!(
        manifest(&s.sandbox.data, &own).is_file(),
        "read failure deleted another manifest"
    );
    assert!(path.is_dir());
    assert!(blob_path(&s.sandbox.data, b"First").is_file());
    assert!(blob_path(&s.sandbox.data, b"Second").is_file());
    assert_eq!(scalar(&s.sandbox.data, "SELECT count(*) FROM outputs")?, 2);
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blob_sweep")?,
        0
    );
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    assert_eq!(
        app.query_row(
            "SELECT count(*) FROM app_session_delete_cleanups WHERE session_id=?1",
            [&source],
            |r| r.get::<_, i64>(0)
        )?,
        1
    );
    s.agent.terminate().await?;
    drop(unreadable);
    std::fs::remove_dir(&path)?;
    std::fs::write(&path, bytes)?;
    s.gw = s.agent.start_again().await?;
    assert!(!manifest(&s.sandbox.data, &own).exists());
    assert_eq!(path.is_file(), stale);
    no_session_rows(&s.sandbox.data, &source)?;
    assert_eq!(
        app.query_row(
            "SELECT count(*) FROM app_session_delete_cleanups WHERE session_id=?1",
            [&source],
            |r| r.get::<_, i64>(0)
        )?,
        0
    );
    if stale {
        live_rows(&s.sandbox.data, &blocked, &parent)?;
        content(&s, &blocked, body).await?;
    } else {
        assert_eq!(scalar(&s.sandbox.data, "SELECT count(*) FROM outputs")?, 0);
        assert!(!blob_path(&s.sandbox.data, b"First").exists());
        assert!(!blob_path(&s.sandbox.data, b"Second").exists());
    }
    s.finish().await
}

#[tokio::test]
async fn stale_marker_io_error_preserves_all_data_until_delete_replay() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    unreadable_delete(true).await
}

#[tokio::test]
async fn real_marker_io_error_preserves_all_data_until_delete_replay() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unreadable_delete(false).await
}
