use super::*;

#[tokio::test]
async fn delete_does_not_walk_the_store() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-KEYED")?;
    schema(&setup.sandbox.data, true)?;
    let survivor = seed(&setup.sandbox.data, "general", "keep", b"Shared", true)?;
    let mut s = setup.start().await?;
    let mut chats = Vec::new();
    for _ in 0..6 {
        chats.push(chat(&s).await?);
    }
    s.agent.terminate().await?;
    for (n, chat) in chats.iter().enumerate() {
        seed(&s.sandbox.data, chat, &n.to_string(), b"Shared", true)?;
    }
    s.gw = s.agent.start_again().await?;
    std::fs::write(
        s.sandbox
            .data
            .join(format!("outputs/manifests/{}.json", hash(b"corrupt"))),
        b"{",
    )?;
    let unreadable = Unreadable::directory(s.sandbox.data.join("outputs/blobs/zz"))?;
    if secure_fs::PERMISSION_MODES {
        assert!(std::fs::read_dir(&unreadable.0).is_err());
    }
    for (n, chat) in chats.iter().enumerate() {
        if n % 2 == 0 {
            delete(&s, chat).await?;
        } else {
            let r =
                s.gw.post(&format!("/sessions/{chat}/archive"), json!({}))
                    .await?;
            assert_eq!(r.status, 200, "{r:?}");
        }
    }
    content(&s, &survivor, "Shared").await?;
    drop(unreadable);
    s.finish().await
}

#[tokio::test]
async fn stuck_record_does_not_walk_per_delete() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-STUCK")?;
    schema(&setup.sandbox.data, true)?;
    seed(&setup.sandbox.data, "general", "keep", b"Shared", true)?;
    let mut s = setup.start().await?;
    let stuck = chat(&s).await?;
    let mut chats = Vec::new();
    for _ in 0..4 {
        chats.push(chat(&s).await?);
    }
    s.agent.terminate().await?;
    let id = seed(&s.sandbox.data, &stuck, "stuck", b"Shared", true)?;
    for chat in &chats {
        seed(&s.sandbox.data, chat, "shared", b"Shared", true)?;
    }
    db(&s.sandbox.data)?.execute_batch(&format!("CREATE TRIGGER fail_delete BEFORE DELETE ON outputs WHEN OLD.id='{id}' BEGIN SELECT RAISE(ABORT,'injected'); END;"))?;
    s.gw = s.agent.start_again().await?;
    let r =
        s.gw.delete(&format!("/sessions/{stuck}?permanent=true"))
            .await?;
    assert_eq!(r.status, 500, "{r:?}");
    std::fs::write(
        s.sandbox
            .data
            .join(format!("outputs/manifests/{}.json", hash(b"corrupt"))),
        b"{",
    )?;
    let watch =
        super::super::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    for chat in &chats {
        delete(&s, chat).await?;
    }
    watch.assert_subtree_unchanged(Path::new("outputs/blobs"))?;
    let db = db(&s.sandbox.data)?;
    for (query, index) in [
        ("SELECT id FROM outputs WHERE session=?1", "outputs_session"),
        (
            "SELECT sha FROM output_blobs WHERE output_id=?1",
            "PRIMARY KEY",
        ),
        (
            "SELECT 1 FROM output_blobs WHERE sha=?1 LIMIT 1",
            "output_blobs_sha",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM output_blobs WHERE sha=?1)",
            "output_blobs_sha",
        ),
        (
            "SELECT sha FROM output_blob_sweep WHERE sha>?1 ORDER BY sha LIMIT 128",
            "PRIMARY KEY",
        ),
    ] {
        let plan = db
            .prepare(&format!("EXPLAIN QUERY PLAN {query}"))?
            .query_map([""], |r| r.get::<_, String>(3))?
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        assert!(plan.contains(index), "{query}: {plan}");
        assert!(
            !plan.contains("SCAN output_") && !plan.contains("TEMP B-TREE"),
            "{plan}"
        );
        eprintln!("BLOB-QUERY-PLAN {query}: {plan}");
    }
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn shared_blob_survives_deletes_of_each_owner() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BLOB-SHARED")?;
    schema(&setup.sandbox.data, false)?;
    let mut s = setup.start().await?;
    let first = chat(&s).await?;
    let second = chat(&s).await?;
    s.agent.terminate().await?;
    seed(&s.sandbox.data, &first, "one", b"Shared", false)?;
    let survivor = seed(&s.sandbox.data, &second, "two", b"Shared", false)?;
    let path = blob(&s.sandbox.data, b"Shared")?;
    db(&s.sandbox.data)?
        .execute_batch("UPDATE output_blob_backfill SET complete=0,cursor='',indexed=0;")?;
    s.gw = s.agent.start_again().await?;
    completed(&s).await?;
    delete(&s, &first).await?;
    assert!(path.is_file());
    content(&s, &survivor, "Shared").await?;
    delete(&s, &second).await?;
    assert!(!path.exists());
    assert_eq!(
        s.gw.get(&format!("/outputs/{survivor}/view")).await?.status,
        403
    );
    s.finish().await
}
