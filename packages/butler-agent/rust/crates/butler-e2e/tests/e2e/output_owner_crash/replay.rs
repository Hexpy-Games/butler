use super::*;
use std::time::Duration;

#[tokio::test]
async fn adopt_replay_heals_owner_through_final_projection() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("OWNER-ADOPT-REPLAY")?;
    schema(&setup.sandbox.data, true)?;
    let release = setup.sandbox.root.join("release");
    let setup = setup
        .env("BUTLER_E2E_HOLD_POINT", "message_attachment")
        .env("BUTLER_E2E_HOLD_RELEASE", release.to_str().unwrap());
    let mut s = setup.start().await?;
    let source = chat(&s).await?;
    let parent = chat(&s).await?;
    let accepted = s.gw.say(&parent, "Publish").await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !release.with_extension("held").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("final projection did not reach barrier".into()))?;
    s.agent.kill9()?;
    let data = &s.sandbox.data;
    let store = OutputStore::new(data);
    let outputs = store.summaries(&parent)?;
    assert_eq!(outputs.len(), 1);
    let id = &outputs[0].output_id;
    let mut output = store.read(id)?;
    let app = butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite"))?;
    let message: String = app.query_row(
        "SELECT id FROM app_owned_messages WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' AND status<>'delivered' ORDER BY rowid DESC LIMIT 1",
        params![parent, turn], |r| r.get(0),
    )?;
    // Supply the child-owned publication that this pending final will adopt.
    output.session_id = source.clone();
    std::fs::write(manifest(data, id), serde_json::to_vec(&output)?)?;
    std::fs::create_dir_all(markers(data, &source))?;
    std::fs::write(markers(data, &source).join(id), [])?;
    std::fs::remove_file(markers(data, &parent).join(id))?;
    db(data)?.execute(
        "UPDATE outputs SET session=?2,turn='child-turn',message='child-message' WHERE id=?1",
        params![id, source],
    )?;
    db(data)?.execute("DELETE FROM output_refs WHERE id=?1", [id])?;
    db(data)?.execute(
        "INSERT INTO output_refs VALUES(?1,?2,'child-turn','child-message')",
        params![id, source],
    )?;
    interrupted_move(data, id, &parent, false)?;
    output = store.read(id)?;
    output.turn_id = turn.clone();
    output.message_id = message;
    std::fs::write(manifest(data, id), serde_json::to_vec(&output)?)?;
    assert_eq!(store.summaries(&source)?.len(), 1);
    assert!(store.summaries(&parent)?.is_empty());
    assert!(markers(data, &source).join(id).is_file());
    std::fs::write(&release, b"release")?;
    s.gw = s.agent.start_again().await?;
    s.gw.wait_terminal(&parent, &turn, Duration::from_secs(30))
        .await?;
    live_rows(data, id, &parent)?;
    let summaries = store.summaries(&parent)?;
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].output_id, *id);
    assert_eq!(summaries[0].turn_id, turn);
    assert!(store.summaries(&source)?.is_empty());
    let page = store.library_page("")?;
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].session_id, parent);
    archive_refs::reference(data, id, &turn, &parent)?;
    let library = s.gw.get("/library?kind=output").await?;
    assert_eq!(library.status, 200, "{library:?}");
    assert_eq!(library.data()["items"][0]["session"], parent);
    s.finish().await
}

async fn delete_parent_first(malformed: bool) -> Result<(), HarnessError> {
    let setup = setup("OWNER-DELETE-PARENT-FIRST")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let source = chat(&s).await?;
    let parent = chat(&s).await?;
    s.agent.terminate().await?;
    let data = &s.sandbox.data;
    let id = seed(data, &source, "adopt", b"Adopted", true)?;
    interrupted_move(data, &id, &parent, false)?;
    if malformed {
        std::fs::write(manifest(data, &id), b"{")?;
    }
    assert!(markers(data, &source).join(&id).is_file());
    let bytes = blob_path(data, b"Adopted");
    s.gw = s.agent.start_again().await?;
    delete(&s, &parent).await?;
    assert!(!manifest(data, &id).exists());
    assert!(!bytes.exists());
    let count: i64 =
        db(data)?.query_row("SELECT count(*) FROM outputs WHERE id=?1", [&id], |r| {
            r.get(0)
        })?;
    assert_eq!(count, 0, "deleted output left a ghost row under the source");
    assert!(OutputStore::new(data).summaries(&source)?.is_empty());
    assert!(OutputStore::new(data).library_page("")?.is_empty());
    delete(&s, &source).await?;
    no_session_rows(data, &source)?;
    no_session_rows(data, &parent)?;
    assert_eq!(scalar(data, "SELECT count(*) FROM output_blobs")?, 0);
    assert_eq!(scalar(data, "SELECT count(*) FROM output_blob_sweep")?, 0);
    s.finish().await
}

#[tokio::test]
async fn delete_new_owner_first_removes_stale_owner_row() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    delete_parent_first(false).await
}

#[tokio::test]
async fn delete_unparseable_new_owner_first_removes_stale_owner_row() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    delete_parent_first(true).await
}
