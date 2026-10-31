//! Uses the canon-link stub's held real Work, not a synthetic running flag.
use super::*;
use crate::canon_mcp::{call, trust};
#[tokio::test]
async fn cn_11_mcp_running_guard_applies_to_every_caller() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, id, chat) = setup("CN-11-RUNNING", false, false).await?;
    trust(&s).await?;
    let original = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
    let mut canon =
        butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = butler_canon::store::Transaction::new(canon.transaction()?)
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    butler_canon::store::create_canon_proposal(&tx,
        &butler_canon::store::Context { now: 1, actor: json!({"person":"app-user","via":"butler","origin":"chat"}) },
        &json!({"id":"running-delete","session_id":"owner","source_turn_id":"turn","source_call_id":"call","project_id":original["project_id"],"summary":"Delete Epic","created_at":"2026-01-01T00:00:00Z",
        "document":{"changes":[{"op":"epic.delete","id":id,"expected_revision":original["revision"]}]}}))
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    tx.commit()?;
    drop(canon);
    let turn = s.gw.say(&chat, "Process the release epic").await?;
    script.wait_held().await;
    assert_eq!(progress(&s, &id).await?["running"], true);
    let epic = call(&s, "canon_get_epic", json!({"epic_id":id})).await?;
    let canon = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    canon.execute("UPDATE canon_proposals SET changes_json=json_set(changes_json,'$.changes[0].expected_revision',?1) WHERE id='running-delete'", [epic["revision"].as_i64().unwrap()])?;
    drop(canon);
    let refused =
        s.gw.send(
            reqwest::Method::DELETE,
            &format!("/canon/epics/{id}"),
            Some(json!({"expected_revision":epic["revision"]}).to_string()),
        )
        .await?;
    assert_eq!(refused.status, 409);
    assert_eq!(refused.error_code(), Some("running"));
    let refused =
        s.gw.post(
            "/canon/proposals/running-delete",
            json!({"outcome":"accepted"}),
        )
        .await?;
    assert_eq!(refused.status, 409, "{refused:?}");
    assert_eq!(refused.error_code(), Some("running"));
    assert_eq!(
        data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200)["revision"],
        epic["revision"]
    );
    let input = json!({"epic_id":id,"expected_revision":epic["revision"],"status":"done"});
    assert_eq!(
        call(&s, "canon_update_epic_status", input).await?["error"]["code"],
        "running"
    );
    let reply =
        s.gw.patch(
            &format!("/canon/epics/{id}"),
            json!({"expected_revision":epic["revision"],"status":"done"}),
        )
        .await?;
    assert_eq!(reply.status, 409);
    assert_eq!(reply.error_code(), Some("running"));
    script.release();
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&turn).await?,
        Duration::from_secs(60),
    )
    .await?;
    let epic = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
    let canon = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let works: i64 = canon.query_row("SELECT count(*) FROM btcc_guided_works", [], |r| r.get(0))?;
    assert!(works > 0);
    let work: String = canon.query_row(
        "SELECT btcc_work_id FROM canon_epic_work_links WHERE epic_id=?1",
        [&id],
        |r| r.get(0),
    )?;
    assert_eq!(
        s.gw.send(
            reqwest::Method::DELETE,
            &format!("/canon/epics/{id}"),
            Some(json!({"expected_revision":epic["revision"]}).to_string())
        )
        .await?
        .status,
        200
    );
    assert_eq!(
        canon.query_row::<i64, _, _>(
            "SELECT count(*) FROM btcc_guided_works WHERE work_id=?1",
            [&work],
            |r| r.get(0)
        )?,
        1
    );
    assert_eq!(
        canon.query_row::<i64, _, _>("SELECT count(*) FROM btcc_guided_works", [], |r| r.get(0))?,
        works
    );
    drop(canon);
    s.finish().await?;
    server.abort();
    Ok(())
}
