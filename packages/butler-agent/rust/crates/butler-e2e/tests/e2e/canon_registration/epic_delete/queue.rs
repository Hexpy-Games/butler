use super::*;

#[tokio::test]
async fn epic_delete_reindexes_middle_releases_dependents_and_starts_successor()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _, server, project, chat) = setup("EPIC-DELETE-QUEUE", Access::AskAlways).await?;
    let mut epics = Vec::new();
    for _ in 0..5 {
        epics.push(create(&s, &project).await?);
    }
    let canon = db(&s)?;
    let owner = butler_gateway::gateway::app_session_hint(&chat);
    for chain in ["main", "other"] {
        canon.execute(
            "INSERT INTO canon_session_queue_chains VALUES(?1,?2,NULL)",
            rusqlite::params![owner, chain],
        )?;
    }
    for (i, epic) in epics.iter().enumerate() {
        let (chain, index, state, reason, held_by) = match i {
            0 => ("main", 0, "running", Some("blocked"), None),
            1 | 2 => (
                "main",
                i,
                "held",
                Some("predecessor_failed"),
                epics[0]["id"].as_str(),
            ),
            3 => ("other", 0, "running", None, None),
            _ => (
                "other",
                1,
                "held",
                Some("predecessor_failed"),
                epics[0]["id"].as_str(),
            ),
        };
        canon.execute("INSERT INTO canon_session_queue(session_id,epic_id,chain_id,step_index,stack_position,state,hold_reason,held_by_epic_id,origin) VALUES(?1,?2,?3,?4,0,?5,?6,?7,'detach')", rusqlite::params![owner,epic["id"].as_str(),chain,index,state,reason,held_by])?;
    }
    assert_eq!(
        delete(&s, &epics[1], &epics[1]["revision"]).await?.status,
        200
    );
    assert_eq!(
        canon.query_row::<i64, _, _>(
            "SELECT step_index FROM canon_session_queue WHERE epic_id=?1",
            [epics[2]["id"].as_str().unwrap()],
            |r| r.get(0)
        )?,
        1
    );
    assert_eq!(
        delete(&s, &epics[0], &epics[0]["revision"]).await?.status,
        200
    );
    assert_eq!(
        canon.query_row::<i64, _, _>(
            "SELECT step_index FROM canon_session_queue WHERE epic_id=?1",
            [epics[2]["id"].as_str().unwrap()],
            |r| r.get(0)
        )?,
        0
    );
    let dependent: (String, Option<String>, Option<String>) = canon.query_row(
        "SELECT state,hold_reason,held_by_epic_id FROM canon_session_queue WHERE epic_id=?1",
        [epics[4]["id"].as_str().unwrap()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(dependent, ("waiting".into(), None, None));
    let next = epics[2]["id"].as_str().unwrap();
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_intents WHERE kind='canon_step' AND json_extract(payload_json,'$.epic_id')=?1", [next], |r|r.get(0))?, 1);
    let events = LiveEvents::subscribe(&s.gw, 0).await?;
    events
        .wait_for(Duration::from_secs(15), |e| {
            e["type"] == "message.updated"
                && e["payload"]["message"]["initiated"]["epic_id"] == next
                && e["payload"]["message"]["status"] == "delivered"
        })
        .await?;
    let turns = s.gw.turns(&chat).await?;
    for turn in turns {
        s.gw.wait_terminal(&chat, turn["id"].as_str().unwrap(), Duration::from_secs(60))
            .await?;
    }
    drop(canon);
    server.abort();
    s.finish().await
}
