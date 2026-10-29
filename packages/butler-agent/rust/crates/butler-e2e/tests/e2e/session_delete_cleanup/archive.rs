//! Archive cleanup debt must not survive unarchive and touch new outputs.
use super::*;

#[derive(Clone, Copy, Debug)]
enum Archive {
    Post,
    Patch,
    Delete,
}

const ROUTES: [Archive; 3] = [Archive::Post, Archive::Patch, Archive::Delete];

async fn fail_archive(s: &Scenario, chat: &str, route: Archive) -> Result<(), HarnessError> {
    let path = format!("/sessions/{chat}");
    let reply = match route {
        Archive::Post => s.gw.post(&format!("{path}/archive"), json!({})).await?,
        Archive::Patch => s.gw.patch(&path, json!({"archived":true})).await?,
        Archive::Delete => s.gw.delete(&path).await?,
    };
    assert_eq!(reply.status, 500, "{route:?}: {reply:?}");
    let db = app(s)?;
    assert!(
        db.query_row("SELECT archived FROM chats WHERE id=?1", [chat], |r| {
            r.get::<_, bool>(0)
        })?
    );
    let pending: i64 = db.query_row(
        "SELECT count(*) FROM app_session_delete_cleanups WHERE session_id=?1",
        [chat],
        |r| r.get(0),
    )?;
    assert_eq!(pending, 1, "archive cleanup must be recorded durably");
    assert_eq!(kind(s, chat)?, "archive");
    assert_eq!(count(&*outputs(s)?, "outputs"), 1);
    Ok(())
}

fn kind(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
    Ok(app(s)?.query_row(
        "SELECT kind FROM app_session_delete_cleanups WHERE session_id=?1",
        [chat],
        |r| r.get(0),
    )?)
}

fn assert_outputs_gone(s: &Scenario, fixture: &Deleted) -> Result<(), HarnessError> {
    let db = outputs(s)?;
    assert_eq!(count(&db, "outputs"), 0);
    assert_eq!(count(&db, "output_refs"), 0);
    let root = s.sandbox.data.join("outputs");
    assert!(
        !root
            .join("manifests")
            .join(format!("{}.json", fixture.output))
            .exists()
    );
    assert!(
        !root
            .join("sessions")
            .join(format!("{:x}", Sha256::digest(fixture.chat.as_bytes())))
            .exists()
    );
    assert_eq!(count(&*app(s)?, "app_session_delete_cleanups"), 0);
    Ok(())
}

#[tokio::test]
async fn failed_archive_cleanup_recovers_on_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for route in ROUTES {
        let mut s = setup("ARCHIVE-CLEANUP-RESTART")?.start().await?;
        let fixture = inject(&mut s).await?;
        fail_archive(&s, &fixture.chat, route).await?;
        s.agent.terminate().await?;
        outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
        s.gw = s.agent.start_again().await?;
        assert_outputs_gone(&s, &fixture)?;
        assert!(app(&s)?.query_row(
            "SELECT archived FROM chats WHERE id=?1",
            [&fixture.chat],
            |r| r.get::<_, bool>(0)
        )?);
        // Archive preserves continuity and message-file ownership.
        assert!(fixture.summary.exists());
        assert!(fixture.upload.exists());
        assert!(fixture.asset.exists());
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn unarchive_cancels_pending_archive_cleanup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for route in ROUTES {
        let mut s = setup("ARCHIVE-CLEANUP-CANCEL")?.start().await?;
        let fixture = inject(&mut s).await?;
        fail_archive(&s, &fixture.chat, route).await?;
        outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
        let reply =
            s.gw.patch(
                &format!("/sessions/{}", fixture.chat),
                json!({"archived":false}),
            )
            .await?;
        assert_eq!(reply.status, 200, "{reply:?}");
        assert_eq!(count(&*app(&s)?, "app_session_delete_cleanups"), 0);
        let (turn_id, turn) = s.turn(&fixture.chat, "Fix").await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
        let manifest = s
            .sandbox
            .data
            .join("outputs/manifests")
            .join(format!("{}.json", fixture.output));
        let published: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest)?)?;
        assert_eq!(
            published["turn_id"], turn_id,
            "new turn must publish output"
        );
        assert_ne!(
            published["revisions"].as_array().unwrap().as_slice(),
            &[] as &[serde_json::Value]
        );
        s.agent.terminate().await?;
        s.gw = s.agent.start_again().await?;
        let actual: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest)?)?;
        assert_eq!(actual, published);
        assert_eq!(count(&*outputs(&s)?, "outputs"), 1);
        assert!(
            s.sandbox
                .data
                .join("outputs/manifests")
                .join(format!("{}.json", fixture.output))
                .exists()
        );
        assert_eq!(count(&*app(&s)?, "app_session_delete_cleanups"), 0);
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn delete_supersedes_pending_archive_cleanup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("ARCHIVE-CLEANUP-DELETE")?.start().await?;
    let fixture = inject(&mut s).await?;
    fail_archive(&s, &fixture.chat, Archive::Post).await?;
    fail_delete(&s, &fixture).await?;
    assert_eq!(kind(&s, &fixture.chat)?, "delete");
    s.agent.terminate().await?;
    outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
    s.gw = s.agent.start_again().await?;
    recovered(&s, &fixture)?;
    s.finish().await
}

#[tokio::test]
async fn stale_archive_records_never_collect_live_or_missing_chat_outputs()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for missing in [false, true] {
        let mut s = setup("ARCHIVE-CLEANUP-STALE")?.start().await?;
        let fixture = inject(&mut s).await?;
        s.agent.terminate().await?;
        outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
        let db = app(&s)?;
        if missing {
            db.execute("DELETE FROM chats WHERE id=?1", [&fixture.chat])?;
        }
        // Simulate a stale recovery record independently of mutation cancellation.
        db.execute(
            "INSERT INTO app_session_delete_cleanups(session_id,kind) VALUES(?1,'archive')",
            [&fixture.chat],
        )?;
        s.gw = s.agent.start_again().await?;
        assert_eq!(count(&*outputs(&s)?, "outputs"), 1);
        assert!(
            s.sandbox
                .data
                .join("outputs/manifests")
                .join(format!("{}.json", fixture.output))
                .exists()
        );
        assert_eq!(count(&*app(&s)?, "app_session_delete_cleanups"), 0);
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn next_archive_recovers_previous_cleanup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for route in ROUTES {
        let mut s = setup("ARCHIVE-CLEANUP-CHANGE")?.start().await?;
        let fixture = inject(&mut s).await?;
        fail_delete(&s, &fixture).await?;
        outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
        let other = chat(&s).await?;
        let path = format!("/sessions/{other}");
        let reply = match route {
            Archive::Post => s.gw.post(&format!("{path}/archive"), json!({})).await?,
            Archive::Patch => s.gw.patch(&path, json!({"archived":true})).await?,
            Archive::Delete => s.gw.delete(&path).await?,
        };
        assert_eq!(reply.status, 200, "{reply:?}");
        recovered(&s, &fixture)?;
        s.finish().await?;
    }
    Ok(())
}
