use super::*;

#[tokio::test]
async fn bundled_intents_replay_in_stack_order() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-BUNDLE-ORDER", false, false).await?;
    let (plan, mut epics) = plan(&s, &script, &first).await?;
    epics[1..].sort_by(|a, b| b.cmp(a));
    let current = data(s.gw.get(&format!("/canon/plans/{plan}")).await?, 200);
    data(
        s.gw.post(
            &format!("/canon/plans/{plan}/order"),
            json!({"expected_revision":current["revision"],"work_ids":epics}),
        )
        .await?,
        200,
    );
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    script.wait_held().await;
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    data(s.gw.post(&format!("/sessions/{chat}/canon/queue/edits"), json!({"expected_graph_revision":view["graph_revision"],"op":"join_stack","epic_id":epics[2],"target_epic_id":epics[1]})).await?, 200);
    script.release();
    wait_done(&s, &chat, 3).await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let actual: Vec<String> = db.prepare("SELECT json_extract(payload_json,'$.epic_id') FROM app_initiated_messages WHERE kind='canon_step' ORDER BY rowid")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    assert_eq!(actual, epics);
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
