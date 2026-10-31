use super::*;

#[tokio::test]
async fn epic_delete_permanent_initiated_failure_without_turn_releases_step()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, project, chat) =
        setup("EPIC-DELETE-ADMISSION-FAILURE", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    s.agent.terminate().await?;
    let owner = format!("butler/app-{chat}");
    let canon = db(&s)?;
    canon.execute(
        "INSERT INTO canon_session_queue_chains VALUES(?1,'chain',NULL)",
        [&owner],
    )?;
    canon.execute("INSERT INTO canon_session_queue(session_id,epic_id,chain_id,step_index,stack_position,state,origin,step_op_id,started_at) VALUES(?1,?2,'chain',0,0,'running','detach','failed-admission',0)",rusqlite::params![owner,id])?;
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    // An invalid durable delivery exercises the ordinary permanent 400 refusal
    // before a turn exists, without introducing a product fault hook.
    app.execute("INSERT INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,state,created_at) VALUES('invalid-step',?1,'canon_step','failed-admission','',?2,'held','2026-01-01')",rusqlite::params![chat,json!({"session_id":owner,"epic_id":id}).to_string()])?;
    s.gw = s.agent.start_again().await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let state: String = app.query_row(
            "SELECT state FROM app_initiated_messages WHERE id='invalid-step'",
            [],
            |r| r.get(0),
        )?;
        if state == "failed" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "permanent refusal was not stored: {state}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(s.gw.turns(&chat).await?, [] as [Value; 0]);
    wait_receipt(&s, id).await?;
    assert_eq!(
        canon.query_row::<String, _, _>(
            "SELECT hold_reason FROM canon_session_queue WHERE epic_id=?1",
            [id],
            |r| r.get(0)
        )?,
        "failed"
    );
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    server.abort();
    s.finish().await
}
