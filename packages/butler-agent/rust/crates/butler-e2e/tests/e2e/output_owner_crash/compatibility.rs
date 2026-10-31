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
    // Clearing skips unservable manifests; pre-migration deletion still requires parsing.
    let kept = clear || !complete;
    assert_eq!(
        r.status,
        if !clear && !complete { 500 } else { 200 },
        "{r:?}"
    );
    if clear {
        let archived = r.data()["archived_session"]["id"].as_str().unwrap();
        let actual: String = db(&s.sandbox.data)?.query_row(
            "SELECT session FROM outputs WHERE id=?1",
            [&id],
            |r| r.get(0),
        )?;
        assert_eq!(actual, archived);
        no_session_rows(&s.sandbox.data, "general")?;
    }
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

fn rows(data: &Path) -> Result<Vec<String>, HarnessError> {
    let db = db(data)?;
    let mut result = Vec::new();
    for sql in [
        "SELECT json_array(id,session,message,turn,title,bytes,created) FROM outputs ORDER BY id",
        "SELECT json_array(id,session,turn,message) FROM output_refs ORDER BY id,turn",
        "SELECT json_array(sha,output_id) FROM output_blobs ORDER BY output_id,sha",
    ] {
        result.extend(
            db.prepare(sql)?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
        );
    }
    Ok(result)
}

#[tokio::test]
async fn same_session_adopt_preserves_existing_rows_and_only_adds_requested_reference()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("OWNER-SAME-SESSION")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let session = chat(&s).await?;
    s.agent.terminate().await?;
    let data = &s.sandbox.data;
    let id = seed(data, &session, "publish-turn", b"Unchanged", true)?;
    // Existing projections need not use the manifest's turn/message or retain its reference.
    db(data)?.execute(
        "UPDATE outputs SET turn='row-turn',message='row-message' WHERE id=?1",
        [&id],
    )?;
    db(data)?.execute("DELETE FROM output_refs WHERE id=?1", [&id])?;
    let before = rows(data)?;
    let manifest_before = std::fs::read(manifest(data, &id))?;
    let store = OutputStore::new(data);
    store.adopt(&id, &session, "reference-turn", "reference-message")?;
    let after = rows(data)?;
    db(data)?.execute(
        "DELETE FROM output_refs WHERE id=?1 AND turn='reference-turn'",
        [&id],
    )?;
    assert_eq!(
        rows(data)?,
        before,
        "same-session adopt rewrote existing rows"
    );
    db(data)?.execute(
        "INSERT INTO output_refs VALUES(?1,?2,'reference-turn','reference-message')",
        params![id, session],
    )?;
    assert_eq!(
        rows(data)?,
        after,
        "adopt changed more than the requested reference"
    );
    store.adopt(&id, &session, "reference-turn", "reference-message")?;
    assert_eq!(rows(data)?, after, "same-session replay changed row bytes");
    assert_eq!(std::fs::read(manifest(data, &id))?, manifest_before);
    s.finish().await
}
