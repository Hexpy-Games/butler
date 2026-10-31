use super::*;
use notify::event::{AccessKind, AccessMode};
use notify::{Config, EventKind, EventKindMask, RecommendedWatcher, RecursiveMode, Watcher};

#[tokio::test]
async fn replaced_manifest_uses_current_revisions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // notify emits Close(Read) only through its Linux inotify backend.
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::linux_test_host(),
        "Linux inotify close-read notification"
    );
    let setup = setup("BLOB-READ-REPLACE-PROOF")?;
    let data = &setup.sandbox.data;
    schema(data, false)?;
    let id = seed(data, "general", "race", b"Old revision", false)?;
    let path = data.join(format!("outputs/manifests/{id}.json"));
    let mut current: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    let new = blob(data, b"Current revision")?;
    let sha = hash(b"Current revision");
    let mut revision = current["revisions"][0].clone();
    revision["revision"] = json!(2);
    revision["files"]["index.html"] = json!(sha);
    current["revisions"].as_array_mut().unwrap().push(revision);
    // Publish's ordering: protect the new revision before atomically replacing the file.
    db(data)?.execute("INSERT INTO output_blobs VALUES(?1,?2)", params![sha, id])?;
    let current = serde_json::to_vec(&current)?;
    // Equal lengths ensure the race also proves the identity fence itself.
    let mut original = std::fs::read(&path)?;
    assert!(original.len() < current.len());
    original.resize(current.len(), b' ');
    std::fs::write(&path, original)?;
    // Same batch, sorted after the target; parsing this file gives the watcher time
    // to replace the already-read target before the batch enters reconciliation.
    let padding_id = "f".repeat(64);
    assert!(padding_id > id, "padding must sort after the target");
    let padding = data.join(format!("outputs/manifests/{padding_id}.json"));
    let padding_output = json!({"kind":"file", "output_id":padding_id,
        "session_id":"general", "message_id":"padding", "turn_id":"padding",
        "title":"p".repeat(32*1024*1024), "revisions":[]});
    std::fs::write(&padding, serde_json::to_vec(&padding_output)?)?;
    drop(padding_output);
    let target = path.clone();
    let (done, completed_replace) = std::sync::mpsc::channel();
    let mut done = Some(done);
    let mut watcher = RecommendedWatcher::new(
        move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            if event.kind == EventKind::Access(AccessKind::Close(AccessMode::Read))
                && event.paths.contains(&target)
                && let Some(done) = done.take()
            {
                let result = secure_fs::replace_private(
                    &target,
                    |file| std::io::Write::write_all(file, &current),
                    |error| error,
                );
                let _ = done.send(result);
            }
        },
        Config::default().with_event_kinds(EventKindMask::ACCESS_CLOSE_NOWRITE),
    )
    .map_err(|e| HarnessError(e.to_string()))?;
    watcher
        .watch(&path, RecursiveMode::NonRecursive)
        .map_err(|e| HarnessError(e.to_string()))?;
    let s = setup.start().await?;
    completed(&s).await?;
    completed_replace
        .recv_timeout(Duration::from_secs(1))
        .map_err(|e| HarnessError(format!("replacement was not observed: {e}")))??;
    let disk: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    assert_eq!(disk["revisions"].as_array().unwrap().len(), 2);
    let rows: i64 = db(&s.sandbox.data)?.query_row(
        "SELECT count(*) FROM output_blobs WHERE output_id=?1",
        [&id],
        |r| r.get(0),
    )?;
    assert_eq!(rows, 2, "stale read removed a current revision row");
    assert!(new.is_file(), "current revision was reclaimed");
    delete(&s, &chat(&s).await?).await?;
    assert!(new.is_file());
    drop(watcher);
    s.finish().await
}
