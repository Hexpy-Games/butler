//! Public multi-turn history uses independent, bounded, stable event pages.
use super::*;
use std::collections::{BTreeMap, HashSet};

#[tokio::test]
async fn steward_activity_history_survives_steps_worker_results_and_restart()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server) = setup("CHILD-ACTIVITY-HISTORY", 3).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (steward, workers) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    let initial = pages(&s, &steward, 3).await?;
    assert!(!initial.is_empty());
    for (index, worker) in workers.iter().enumerate() {
        script.release(&format!("red-{index}"));
        closed(&s, worker["session_id"].as_str().unwrap()).await?;
        if index == 0 {
            started(&script, 3).await;
        }
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let history = pages(&s, &steward, 3).await?;
        if history.keys().any(|turn| !initial.contains_key(turn)) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "no result turn history: {}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Restart after all queue work has settled; the fresh read has no cached client state.
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let history = pages(&s, &steward, 3).await?;
    assert_eq!(history, pages(&s, &steward, 200).await?);
    for (turn, ids) in initial {
        assert!(
            ids.iter().all(|id| history[&turn].contains(id)),
            "lost earlier activity"
        );
    }
    let database = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let expected: Vec<(String, String)> = database.prepare(
        "SELECT turn_id,event_id FROM btcc_progress_events WHERE session_id=?1 \
         AND json_extract(event_json,'$.visibility')='public' \
         AND json_extract(event_json,'$.kind') IN ('tool.started','tool.completed','assistant.public_note') \
         ORDER BY session_sequence",
    )?.query_map([&steward], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<Result<_, _>>()?;
    assert_ne!(expected.len(), 0, "expected persisted public activity");
    for (turn, id) in expected {
        assert!(history[&turn].contains(&id), "missing {id}");
    }
    println!(
        "child history: {} turns, {} public rows, page sizes 3/200",
        history.len(),
        history.values().map(Vec::len).sum::<usize>()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn pages(
    s: &Scenario,
    child: &str,
    limit: usize,
) -> Result<BTreeMap<String, Vec<String>>, HarnessError> {
    let mut cursor = String::new();
    let mut seen = HashSet::new();
    let mut sequences = BTreeMap::new();
    let mut history: BTreeMap<String, Vec<String>> = BTreeMap::new();
    loop {
        let page =
            s.gw.get(&format!(
                "/session-view?session_id={child}&limit={limit}{cursor}"
            ))
            .await?;
        assert_eq!(page.status, 200, "{page:?}");
        for entry in page.data()["activity_history"].as_array().unwrap() {
            let turn = entry["turn_id"].as_str().unwrap().to_owned();
            let ids = history.entry(turn.clone()).or_default();
            let last = sequences.entry(turn.clone()).or_insert(0);
            for row in entry["rows"].as_array().unwrap() {
                let seq = row["turn_event_sequence"].as_u64().unwrap();
                assert!(seq > *last, "source order across pages");
                *last = seq;
                let id = row["id"].as_str().unwrap().to_owned();
                assert!(seen.insert(id.clone()), "duplicate event {id}");
                ids.push(id);
            }
        }
        let window = &page.data()["activity_window"];
        if window["has_more"] != true {
            break;
        }
        cursor = format!(
            "&activity_cursor_token={}",
            window["next_cursor_token"].as_str().unwrap()
        );
    }
    Ok(history)
}

/// Old installations already saved the late failure; a fresh projection must
/// still use the completed Work's result, without rewriting that history.
pub(super) async fn assert_legacy_late_failure(
    s: &mut Scenario,
    steward: &str,
) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute(
        "INSERT INTO btcc_steward_results(result_id,relation_id,task_id,child_session_id,child_turn_id,status,code,summary,acceptance_evidence_json,changed_artifacts_json,created_at) \
         SELECT 'historical-late-failure',r.relation_id,d.task_id,r.child_session_id, \
         (SELECT turn_id FROM btcc_turns WHERE session_id=r.child_session_id ORDER BY rowid DESC LIMIT 1), \
         'failed','steward_execution_failed','Interrupted','[]','[]',strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) WHERE r.child_session_id=?1",
        [steward],
    )?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let child =
        s.gw.get(&format!("/session-view?session_id={steward}"))
            .await?;
    assert_eq!(child.data()["status"], "delivered", "{child:?}");
    assert_eq!(child.data()["result"]["status"], "success");
    assert_eq!(child.data()["latest_turn"]["state"], "delivered");
    assert!(child.data()["active_turn"].is_null());
    Ok(())
}
