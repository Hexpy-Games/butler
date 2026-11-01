//! Archive cannot release the delete guard before a finishing Turn ends.
use super::*;
use std::{sync::atomic::Ordering, time::Instant};

#[tokio::test]
async fn epic_delete_review_archive_waits_for_linked_step_turn_to_end() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) = crate::canon_link::setup_env(
        "EPIC-DELETE-ARCHIVE-FINISHING",
        false,
        false,
        None,
        Some(("BUTLER_E2E_HOLD_DELIVERY", "before".into())),
    )
    .await?;
    held_steps::stopped_work(&s, &script, &first, &chat).await?;
    script.quick.store(true, Ordering::SeqCst);
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":first}),
        )
        .await?,
        200,
    );
    // Pause before canonical message insertion: insertion can already publish
    // the App terminal receipt, before BTCC acknowledges delivery.
    let deadline = Instant::now() + Duration::from_secs(30);
    while !s.sandbox.data.join("e2e-delivery-held").exists() {
        assert!(Instant::now() < deadline, "delivery barrier was not reached");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let canon = db(&s)?;
    let op: String = canon.query_row(
        "SELECT step_op_id FROM canon_session_queue WHERE epic_id=?1",
        [&first],
        |r| r.get(0),
    )?;
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let turn: String = app.query_row(
        "SELECT t.id FROM turns t JOIN app_initiated_messages i ON i.message_id=t.user_message_id WHERE i.source_key=?1",
        [&op],
        |r| r.get(0),
    )?;
    assert_eq!(
        std::fs::read_to_string(s.sandbox.data.join("e2e-delivery-held"))?,
        turn
    );
    drop(app);
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_session_queue q JOIN btcc_turns t ON t.session_id=q.session_id WHERE q.epic_id=?1 AND q.turn_ended_at IS NULL AND t.semantic_state='delivery_committed'", [&first], |r|r.get(0))?,1);
    data(
        s.gw.post(&format!("/sessions/{chat}/archive"), json!({}))
            .await?,
        200,
    );
    assert_eq!(canon.query_row::<String,_,_>("SELECT hold_reason FROM canon_session_queue WHERE epic_id=?1 AND turn_ended_at IS NULL", [&first], |r|r.get(0))?,"cancelled");
    let epic = data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200);
    let refusal = delete(&s, &epic, &epic["revision"]).await?;
    assert_eq!(refusal.status, 409, "{}", refusal.text);
    assert_eq!(refusal.body["error"]["code"], "running");
    assert_eq!(epic["running"], true, "{epic}");
    std::fs::write(s.sandbox.data.join("e2e-delivery-release"), b"1")?;
    wait_receipt(&s, &first).await?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    drop(canon);
    s.finish().await?;
    server.abort();
    Ok(())
}
