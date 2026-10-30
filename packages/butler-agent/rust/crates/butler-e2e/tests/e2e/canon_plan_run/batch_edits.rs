use super::*;
use butler_e2e::e2e::scenario::Scenario;
use rusqlite::{Connection, params};
use serde_json::Value;
use std::{sync::atomic::Ordering, time::Duration};

// Reproduce a durable idle-but-ready queue, before its next explicit act.
fn seed(
    s: &Scenario,
    chat: &str,
    plan: &str,
    epics: &[String],
    held: bool,
) -> Result<Connection, HarnessError> {
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let owner = butler_gateway::gateway::app_session_hint(chat);
    db.execute(
        "INSERT INTO canon_session_queue_heads VALUES(?1,10)",
        [&owner],
    )?;
    db.execute(
        "INSERT INTO canon_session_queue_chains VALUES(?1,'source',?2)",
        params![owner, plan],
    )?;
    for (position, epic) in epics.iter().enumerate() {
        db.execute("INSERT INTO canon_session_queue(session_id,epic_id,chain_id,step_index,stack_position,state,origin) VALUES(?1,?2,'source',?3,?4,?5,'user_message')", params![owner,epic,usize::from(position>0),position.saturating_sub(1),if held && position==0 {"held"} else {"waiting"}])?;
    }
    Ok(db)
}
fn order(view: &Value, chain: usize) -> Vec<Vec<String>> {
    view["chains"][chain]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|step| {
            step["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["epic_id"].as_str().unwrap().to_owned())
                .collect()
        })
        .collect()
}
async fn edit(
    s: &Scenario,
    chat: &str,
    args: Value,
) -> Result<butler_e2e::e2e::gateway::Reply, HarnessError> {
    s.gw.post(&format!("/sessions/{chat}/canon/queue/edits"), args)
        .await
}
#[tokio::test]
async fn batch_move_keeps_order_and_bumps_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CANON-BATCH-ORDER", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    let db = seed(&s, &chat, &plan, &epics, true)?;
    let view=data(edit(&s,&chat,json!({"expected_graph_revision":10,"op":"move_to_new_step","epic_ids":[epics[2],epics[1]],"index":0})).await?,200);
    assert_eq!(view["graph_revision"], 11);
    assert_eq!(
        order(&view, 0),
        vec![vec![epics[2].clone(), epics[1].clone()], vec![first]]
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_step'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn batch_move_stale_cas_changes_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CANON-BATCH-CAS", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    let db = seed(&s, &chat, &plan, &epics, true)?;
    let path = format!("/sessions/{chat}/canon/queue");
    let before = data(s.gw.get(&path).await?, 200);
    let reply=edit(&s,&chat,json!({"expected_graph_revision":9,"op":"move_to_new_step","epic_ids":[epics[1],epics[2]],"index":0})).await?;
    assert_eq!(reply.status, 409, "{}", reply.text);
    assert_eq!(reply.body["graph_revision"], 10);
    assert_eq!(data(s.gw.get(&path).await?, 200), before);
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_step'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    assert!(script.requests.lock().unwrap().is_empty());
    // The same payload with the current revision must be supported.
    data(edit(&s,&chat,json!({"expected_graph_revision":10,"op":"move_to_new_step","epic_ids":[epics[1],epics[2]],"index":0})).await?,200);
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn batch_move_never_starts_an_intermediate_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CANON-BATCH-READY", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.quick.store(true, Ordering::SeqCst);
    let db = seed(&s, &chat, &plan, &epics, false)?;
    // Every intent and queue event records the entire membership at insertion.
    db.execute_batch("CREATE TABLE observed(kind TEXT,layout TEXT); CREATE TRIGGER observe_intent AFTER INSERT ON canon_intents WHEN NEW.kind='canon_step' BEGIN INSERT INTO observed SELECT 'intent',json_group_array(json_object('epic',epic_id,'step',step_index,'pos',stack_position)) FROM (SELECT * FROM canon_session_queue ORDER BY step_index,stack_position); END; CREATE TRIGGER observe_event AFTER INSERT ON canon_events WHEN NEW.topic='canon.queue_changed' BEGIN INSERT INTO observed SELECT 'event',json_group_array(json_object('epic',epic_id,'step',step_index,'pos',stack_position)) FROM (SELECT * FROM canon_session_queue ORDER BY step_index,stack_position); END;")?;
    let view=data(edit(&s,&chat,json!({"expected_graph_revision":10,"op":"move_to_new_step","epic_ids":[epics[1],epics[2]],"index":0})).await?,200);
    assert_eq!(view["graph_revision"], 11);
    assert_eq!(
        order(&view, 0),
        vec![epics[1..].to_vec(), vec![first.clone()]]
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let turns = s.gw.turns(&chat).await?;
        if turns.len() == 2 {
            for turn in turns {
                s.gw.wait_terminal(&chat, turn["id"].as_str().unwrap(), Duration::from_secs(30))
                    .await?;
            }
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{turns:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let layouts = db
        .prepare("SELECT layout FROM observed")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    assert!(layouts.len() >= 3);
    for raw in layouts {
        assert_eq!(
            serde_json::from_str::<Value>(&raw)?,
            json!([{"epic":epics[1],"step":0,"pos":0},{"epic":epics[2],"step":0,"pos":1},{"epic":first,"step":1,"pos":0}])
        );
    }
    let started=db.prepare("SELECT json_extract(payload_json,'$.epic_id') FROM canon_intents WHERE kind='canon_step' ORDER BY rowid")?.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    assert_eq!(started, epics[1..]);
    let requests = script.requests.lock().unwrap().clone();
    // Background memory extraction shares the provider; inspect all step requests.
    let requested = requests
        .iter()
        .map(|body| {
            butler_e2e::e2e::matching::key(
                "/codex/responses",
                body,
                &butler_e2e::e2e::sanitize::Placeholders::default(),
            )
            .user_request
        })
        .filter(|request| request.starts_with("canon:epic/"))
        .collect::<Vec<_>>();
    assert_eq!(
        requested,
        epics[1..]
            .iter()
            .map(|id| format!("canon:epic/{id}"))
            .collect::<Vec<_>>()
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

mod atomic;
mod validation;
