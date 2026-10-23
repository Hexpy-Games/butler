//! Pending legacy dispatch resumes as a part under the parent's Task lease.
use super::*;

#[tokio::test]
async fn legacy_dispatch_imports_a_part_and_returns_to_its_parent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script.hold_report.store(false, Ordering::SeqCst);
    let mut s = Setup::new("WMU-LEGACY-PART")?
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    s.turn("general", "What is two plus two?").await?;
    s.agent.terminate().await?;
    let root = s.sandbox.data.clone();
    let parent = super::super::database(&s, move |db| seed(db, &root)).await?;
    let before = legacy_rows(&s).await?;
    s.gw = s.agent.start_again().await?;
    tokio::time::timeout(Duration::from_secs(30), script.child_held.notified())
        .await
        .expect("recovered child executes");
    let parent_check = parent.clone();
    let assigned = super::super::database(&s, move |db| db.query_row(
        "SELECT p.task_id,p.id,a.session_id FROM wm_task_parts p JOIN wm_attempts a ON a.task_id=p.task_id AND a.part_id IS NULL WHERE p.assignee_session_id='steward-recovery' AND a.status='running'", [],
        |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))).await?;
    assert_eq!(assigned.2, parent_check, "the parent keeps the Task lease");
    script.release_child.notify_one();
    wait_completed(&s, &json!(assigned.0)).await?;
    wait_message(&s, stub::RESULT).await?;
    assert_eq!(
        legacy_rows(&s).await?,
        before,
        "legacy sources stay read-only"
    );
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(legacy_rows(&s).await?, before);
    let counts = super::super::database(&s, |db| {
        db.query_row(
            "SELECT (SELECT count(*) FROM wm_task_parts),(SELECT count(*) FROM wm_results)",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
    })
    .await?;
    assert_eq!(counts, (1, 1), "recovery and result delivery run once");
    s.finish().await?;
    server.abort();
    Ok(())
}

fn seed(db: &rusqlite::Connection, root: &std::path::Path) -> rusqlite::Result<String> {
    let parent: String = db.query_row(
        "SELECT session_id FROM btcc_turns ORDER BY rowid LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    let turn: String = db.query_row(
        "SELECT turn_id FROM btcc_turns ORDER BY rowid LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    let names = db.prepare("SELECT type,name FROM sqlite_schema WHERE name GLOB 'wm_*' AND type IN ('trigger','table') ORDER BY type DESC")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (kind, name) in names {
        db.execute_batch(&format!("DROP {kind} \"{name}\""))?;
    }
    db.execute("INSERT INTO btcc_guided_works(work_id,session_id,scope_kind,scope_ref,origin_turn_id,origin_message_id,objective,status,current_plan_revision_id,created_at,updated_at) VALUES('retained-work','steward-recovery','session',?1,?2,'kept-message',?3,'open','retained-plan','2026-10-01','2026-10-01')",rusqlite::params![parent,turn,stub::FEATURE])?;
    db.execute("INSERT INTO btcc_guided_work_plan_revisions VALUES('retained-plan','retained-work',1,?1,'[]','direct','[{\"actionKey\":\"marker\",\"description\":\"Build marker\",\"dependencyKeys\":[]}]','[]',?2,'2026-10-01')",rusqlite::params![stub::FEATURE,turn])?;
    db.execute("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES('retained-relation',?1,?2,'steward-recovery','kept-message',1,'Build marker','2026-10-01')",rusqlite::params![parent,turn])?;
    let packet = json!({"child_role":"steward","delegation_id":"retained-delegation","task_id":"retained-task","parent_session_id":parent,"parent_turn_id":turn,"parent_chat_id":"general","relation_id":"retained-relation","access_mode":"full_access","execution_mode":"mutation","objective":stub::FEATURE,"acceptance_criteria":["Marker built"],"task_or_plan_refs":[],"constraints_and_non_goals":[],"allowed_tools_and_effects":["write_file:workspace"],"mutation_scope":["feature-marker.txt"],"model_ref":"openai/gpt-6-luna","reasoning_effort":"medium"});
    let intent = json!({"envelope":{"eventId":"retained-dispatch","transport":"app","accountId":"local","peer":{"kind":"dm","id":"steward-recovery","parentId":"general"},"sender":{"id":"butler-steward-dispatch","displayName":"Butler Steward"},"message":{"id":"retained-message","text":"role: steward\nBuild the requested marker.","timestamp":"2026-10-01T00:00:00Z"},"routingHints":{"sessionId":"steward-recovery","turnId":"retained-child-turn"},"nativeStewardContext":{"version":1,"role":"steward","projectName":"","workspacePath":root,"modelRef":"openai/gpt-6-luna","reasoningEffort":"medium"},"raw":{"source":"btcc-subsession-delegation"}},"metadata":{"source":"btcc-subsession"}});
    db.execute("INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,dispatch_intent_json,dispatch_state,created_at) VALUES('retained-delegation','retained-relation','retained-task','retained-child-turn','retained-work',?1,?2,'pending','2026-10-01')",rusqlite::params![packet.to_string(),intent.to_string()])?;
    Ok(parent)
}

async fn legacy_rows(s: &Scenario) -> Result<Vec<String>, HarnessError> {
    super::super::database(s, |db| {
        let mut result = Vec::new();
        for table in [
            "btcc_guided_works",
            "btcc_guided_work_plan_revisions",
            "btcc_guided_work_checkpoint_revisions",
            "btcc_subsession_delegations",
            "btcc_subsession_directions",
            "btcc_steward_results",
        ] {
            let mut stmt = db.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
            let count = stmt.column_count();
            result.extend(
                stmt.query_map([], |r| {
                    (0..count)
                        .map(|i| r.get_ref(i).map(|v| format!("{v:?}")))
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map(|row| format!("{table}:{}", row.join("|")))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            );
        }
        Ok(result)
    })
    .await
}
