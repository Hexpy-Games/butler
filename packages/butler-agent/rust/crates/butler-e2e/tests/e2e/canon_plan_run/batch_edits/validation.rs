use super::*;

#[tokio::test]
async fn batch_move_validates_all_members_and_destinations() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CANON-BATCH-VALIDATION", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    let db = seed(&s, &chat, &plan, &epics, true)?;
    let path = format!("/sessions/{chat}/canon/queue");
    let before = data(s.gw.get(&path).await?, 200);
    for (selection, feedback) in [
        (json!({"epic_ids":[]}), "nonempty"),
        (json!({"epic_ids":[epics[1],epics[1]]}), "duplicate"),
        (json!({"epic_ids":[epics[1],"unknown"]}), "not found"),
        (
            json!({"epic_id":epics[1],"epic_ids":[epics[2]]}),
            "exactly one",
        ),
        (json!({"epic_ids":[epics[1],3]}), "strings"),
    ] {
        let mut args = json!({"expected_graph_revision":10,"op":"move_to_new_step","index":0});
        args.as_object_mut()
            .unwrap()
            .extend(selection.as_object().unwrap().clone());
        let reply = edit(&s, &chat, args).await?;
        assert_eq!(
            reply.status,
            if feedback == "not found" { 404 } else { 400 },
            "{}",
            reply.text
        );
        assert!(reply.text.contains(feedback), "{}", reply.text);
        assert_eq!(data(s.gw.get(&path).await?, 200), before);
    }
    db.execute(
        "UPDATE canon_session_queue SET state='done' WHERE epic_id=?1",
        [&epics[2]],
    )?;
    let reply=edit(&s,&chat,json!({"expected_graph_revision":10,"op":"move_to_new_step","epic_ids":[epics[1],epics[2]],"index":0})).await?;
    assert_eq!(reply.status, 400, "{}", reply.text);
    assert!(reply.text.contains("done"));
    db.execute(
        "UPDATE canon_session_queue SET state='waiting' WHERE epic_id=?1",
        [&epics[2]],
    )?;
    let view=data(edit(&s,&chat,json!({"expected_graph_revision":10,"op":"join_stack","epic_ids":[epics[2],epics[1]],"target_epic_id":first})).await?,200);
    assert_eq!(view["graph_revision"], 11);
    assert_eq!(
        order(&view, 0),
        vec![vec![first.clone(), epics[2].clone(), epics[1].clone()]]
    );
    let owner = butler_gateway::gateway::app_session_hint(&chat);
    db.execute(
        "INSERT INTO canon_session_queue_chains VALUES(?1,'target',?2)",
        params![owner, plan],
    )?;
    db.execute("UPDATE canon_session_queue SET chain_id='target',step_index=0,stack_position=0 WHERE epic_id=?1",[&first])?;
    db.execute(
        "UPDATE canon_session_queue SET stack_position=stack_position-1 WHERE chain_id='source'",
        [],
    )?;
    let view=data(edit(&s,&chat,json!({"expected_graph_revision":11,"op":"move_between","epic_ids":[epics[1],epics[2]],"target_chain_id":"target","index":1})).await?,200);
    assert_eq!(view["graph_revision"], 12);
    assert_eq!(view["chains"].as_array().unwrap().len(), 1);
    assert_eq!(
        order(&view, 0),
        vec![
            vec![first.clone()],
            vec![epics[1].clone(), epics[2].clone()]
        ]
    );
    // Cross-chain stack placement also appends the whole ordered selection.
    db.execute("UPDATE canon_session_queue SET chain_id='source',step_index=0,stack_position=stack_position WHERE epic_id<>?1",[&first])?;
    let view=data(edit(&s,&chat,json!({"expected_graph_revision":12,"op":"move_between","epic_ids":[epics[2],epics[1]],"target_chain_id":"target","target_epic_id":first})).await?,200);
    assert_eq!(view["graph_revision"], 13);
    assert_eq!(
        order(&view, 0),
        vec![vec![first, epics[2].clone(), epics[1].clone()]]
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
