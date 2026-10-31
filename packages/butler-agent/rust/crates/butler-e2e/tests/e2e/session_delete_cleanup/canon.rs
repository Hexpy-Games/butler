use super::*;
use butler_e2e::e2e::{config, provider::Provider, sanitize::Placeholders};
use std::time::Instant;

pub(super) async fn artifacts(
    s: &mut Scenario,
    chat: String,
) -> Result<(Deleted, Provider), HarnessError> {
    let cassette = crate::browser_outputs::stub::cassette()?;
    let provider_name = cassette.meta.provider.clone();
    let provider = Provider::replay(cassette, Placeholders::default()).await?;
    if let Some((_, issuer)) = s
        .agent
        .launch
        .env
        .iter()
        .find(|(key, _)| key == "BUTLER_CHATGPT_AUTH_ISSUER")
    {
        provider.chatgpt_authority(issuer);
    }
    s.agent.terminate().await?;
    s.agent.launch.set_env(
        config::base_url_env(&provider_name).unwrap(),
        format!("{}{}", provider.base_url, config::base_path(&provider_name)),
    );
    s.gw = s.agent.start_again().await?;
    Ok((inject_chat(s, chat).await?, provider))
}

fn canon(s: &Scenario) -> Result<sqlite::Connection, HarnessError> {
    Ok(sqlite::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    )?)
}

fn bindings(db: &Connection, deleted: &Deleted) -> i64 {
    db.query_row(
        "SELECT count(*) FROM canon_session_epics WHERE session_id=?1",
        [&deleted.hint],
        |r| r.get(0),
    )
    .unwrap()
}

fn revision(db: &Connection, deleted: &Deleted) -> rusqlite::Result<i64> {
    db.query_row(
        "SELECT revision FROM canon_intents WHERE op_id=?1",
        [format!("session-delete:{}", deleted.chat)],
        |r| r.get(0),
    )
}

#[tokio::test]
async fn canon_failure_does_not_skip_cleanup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _script, server, epic, chat) =
        crate::canon_link::setup("DELETE-CANON-FAILURE", false, false).await?;
    let (deleted, provider) = artifacts(&mut s, chat).await?;
    outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
    let canon = canon(&s)?;
    let bound = bindings(&canon, &deleted);
    assert_eq!(bound, 2);
    canon.execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON canon_session_epics BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;")?;
    let reply =
        s.gw.delete(&format!("/sessions/{}?permanent=true", deleted.chat))
            .await?;
    assert_eq!(reply.status, 500, "{reply:?}");
    let app = app(&s)?;
    assert_eq!(count(&app, "chats"), 1, "only General remains");
    recovered(&s, &deleted)?;
    assert_eq!(count(&app, "app_canon_session_deletes"), 1);
    assert_eq!(bindings(&canon, &deleted), bound);
    canon.execute_batch("DROP TRIGGER refuse_delete")?;
    let path = format!("/canon/epics/{epic}");
    let row = s.gw.get(&path).await?;
    assert_eq!(row.status, 200, "{row:?}");
    let changed =
        s.gw.patch(
            &path,
            json!({"expected_revision":row.data()["revision"],"title":"Changed"}),
        )
        .await?;
    assert_eq!(changed.status, 200, "{changed:?}");
    let deadline = Instant::now() + Duration::from_secs(5);
    while count(&app, "app_canon_session_deletes") != 0 {
        assert!(Instant::now() < deadline, "canon receipt was not replayed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(bindings(&canon, &deleted), 0);
    recovered(&s, &deleted)?;
    s.finish().await?;
    provider.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cleanup_failure_does_not_replay_canon() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _script, server, _epic, chat) =
        crate::canon_link::setup("DELETE-CLEANUP-CANON-ONCE", false, false).await?;
    let (deleted, provider) = artifacts(&mut s, chat).await?;
    let canon = canon(&s)?;
    assert_eq!(bindings(&canon, &deleted), 2);
    fail_delete(&s, &deleted).await?;
    assert_eq!(count(&*app(&s)?, "app_canon_session_deletes"), 0);
    assert_eq!(bindings(&canon, &deleted), 0);
    let before = revision(&canon, &deleted)?;
    s.agent.terminate().await?;
    outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
    s.gw = s.agent.start_again().await?;
    recovered(&s, &deleted)?;
    assert_eq!(count(&*app(&s)?, "app_canon_session_deletes"), 0);
    assert_eq!(bindings(&canon, &deleted), 0);
    assert_eq!(revision(&canon, &deleted)?, before);
    s.finish().await?;
    provider.finish().await?;
    server.abort();
    Ok(())
}
