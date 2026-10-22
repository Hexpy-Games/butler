//! Small deterministic contracts live in the E2E crate so production-crate
//! ratchets stay unchanged. Startup/import user flows are in work_model_cutover.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
use butler_work::{
    cutover::{self, Action, Reimport},
    store, work_schema,
};
use rusqlite::Connection;

// test-category: pure-logic
#[test]
fn downgrade_decisions_preserve_new_edits() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    assert_eq!(cutover::reimport("same", "same", 7, 0), Reimport::Skip);
    assert_eq!(cutover::reimport("new", "old", 3, 3), Reimport::InPlace);
    assert_eq!(cutover::reimport("new", "old", 4, 3), Reimport::Separate);
    let db = Connection::open_in_memory().unwrap();
    work_schema::ensure(&db).unwrap();
    db.execute(
        "INSERT INTO wm_migration VALUES(1,'complete','{}','{}',?1,0,'[]')",
        [cutover::WRITER_EPOCH + 1],
    )
    .unwrap();
    assert!(
        cutover::check_epoch(&db)
            .unwrap_err()
            .to_string()
            .contains("newer Butler")
    );
    assert!(work_schema::ensure(&db).is_err());
    Ok(())
}
fn actions(graph: &[(&str, &[&str])]) -> Vec<Action> {
    graph
        .iter()
        .map(|(id, deps)| Action {
            action_key: (*id).into(),
            description: (*id).into(),
            dependency_keys: deps.iter().map(|s| (*s).into()).collect(),
        })
        .collect()
}
// test-category: pure-logic
#[test]
fn flat_orders_and_general_dags_keep_all_actions_and_edges()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let graph = actions(&[("a", &[]), ("b", &["a"]), ("c", &["a"]), ("d", &["b", "c"])]);
    let layout = cutover::layout(&graph).unwrap();
    let chains = layout.chains.unwrap();
    assert_eq!(chains.len(), 1);
    assert_eq!(
        chains[0]
            .steps
            .iter()
            .map(|s| s.tasks.len())
            .collect::<Vec<_>>(),
        vec![1, 2, 1]
    );
    assert_eq!(chains[0].edges().unwrap(), layout.edges);
    let non_sp = actions(&[("a", &[]), ("b", &[]), ("c", &["a"]), ("d", &["a", "b"])]);
    let layout = cutover::layout(&non_sp).unwrap();
    assert!(layout.chains.is_none());
    assert_eq!(layout.edges.len(), 3);
    assert!(cutover::layout(&actions(&[("a", &["b"]), ("b", &["a"])])).is_err());
    Ok(())
}

fn legacy_db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../fixtures/work-model-cutover/schema.sql"))
        .unwrap();
    work_schema::ensure(&db).unwrap();
    db.execute_batch(include_str!("../fixtures/work-model-cutover/btcc.sql"))
        .unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    db
}
fn ctx() -> store::Context {
    store::Context {
        now: 1000,
        actor: serde_json::json!({"origin":"migration"}),
    }
}
fn migrate(db: &mut Connection) {
    let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
    cutover::begin(&tx, cutover::CutoverState::Pending).unwrap();
    let active = cutover::resume(&tx, cutover::CutoverState::Importing).unwrap();
    tx.commit().unwrap();
    if !active {
        return;
    }
    loop {
        let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
        let more = cutover::batch(&tx, &ctx()).unwrap();
        tx.commit().unwrap();
        if !more {
            break;
        }
    }
}
// test-category: pure-logic
#[test]
fn replaying_a_committed_batch_preserves_ids_and_cursor()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let mut db = legacy_db();
    let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
    cutover::begin(&tx, cutover::CutoverState::Pending).unwrap();
    cutover::resume(&tx, cutover::CutoverState::Importing).unwrap();
    assert!(cutover::batch(&tx, &ctx()).unwrap());
    tx.commit().unwrap();
    let before: String = db
        .query_row(
            "SELECT json_group_array(json_array(id,revision,task_graph_revision)) FROM wm_works",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let cursor: String = db
        .query_row(butler_work::cutover::CURSOR, [], |r| r.get(0))
        .unwrap();
    let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
    tx.execute(
        "UPDATE wm_migration SET cursor_json='{}' WHERE singleton=1",
        [],
    )
    .unwrap();
    assert!(cutover::batch(&tx, &ctx()).unwrap());
    tx.commit().unwrap();
    assert_eq!(
        db.query_row::<String, _, _>(
            "SELECT json_group_array(json_array(id,revision,task_graph_revision)) FROM wm_works",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        before
    );
    assert_eq!(
        db.query_row::<String, _, _>(butler_work::cutover::CURSOR, [], |r| r.get(0))
            .unwrap(),
        cursor
    );
    migrate(&mut db);
    let ids: String = db
        .query_row("SELECT json_group_array(id) FROM wm_tasks", [], |r| {
            r.get(0)
        })
        .unwrap();
    migrate(&mut db);
    assert_eq!(
        db.query_row::<String, _, _>("SELECT json_group_array(id) FROM wm_tasks", [], |r| r
            .get(0))
            .unwrap(),
        ids
    );
    Ok(())
}

// test-category: pure-logic
#[test]
fn interrupted_backup_is_redone_and_completed_set_is_reused()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    use butler_work::cutover::CutoverState;
    let root = std::env::temp_dir().join(format!("work-backup-{}", uuid::Uuid::new_v4()));
    for (folder, name) in [
        ("agent-runtime", "btcc.sqlite"),
        ("app-server", "butler-client.sqlite"),
    ] {
        std::fs::create_dir_all(root.join(folder)).unwrap();
        let db = Connection::open(root.join(folder).join(name)).unwrap();
        db.execute_batch("CREATE TABLE original(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO original VALUES(1,'kept')").unwrap();
    }
    let backups = root.join("backups/work-model-cutover");
    let incomplete = backups.join("20000101T000000.000000000Z");
    std::fs::create_dir_all(&incomplete).unwrap();
    std::fs::write(incomplete.join("btcc.sqlite"), b"incomplete").unwrap();
    assert_eq!(cutover::prepare(&root).unwrap(), CutoverState::Importing);
    assert!(!incomplete.exists());
    let sets = || {
        std::fs::read_dir(&backups)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>()
    };
    let before = sets();
    assert_eq!(before.len(), 1);
    assert!(cutover::valid(&before[0]).unwrap());
    assert_eq!(cutover::prepare(&root).unwrap(), CutoverState::Importing);
    assert_eq!(before, sets());
    for name in ["btcc.sqlite", "butler-client.sqlite"] {
        let db = Connection::open(before[0].join(name)).unwrap();
        assert_eq!(
            db.query_row::<String, _, _>("SELECT value FROM original WHERE id=1", [], |r| r.get(0))
                .unwrap(),
            "kept"
        );
    }
    std::fs::remove_dir_all(root).unwrap();
    Ok(())
}

// test-category: format-pin
#[test]
fn every_cutover_statement_has_a_pinned_query_plan() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    use rusqlite::{params_from_iter, types::Value};
    let db = legacy_db();
    db.execute_batch(include_str!("../fixtures/work-model-cutover/app.sql"))
        .unwrap();
    db.execute_batch("CREATE INDEX chats_project_artifacts_idx ON chats(project_id,id)")
        .unwrap();
    let mut plans = serde_json::Map::new();
    for (name, sql) in butler_work::cutover::ALL {
        let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let count = stmt.parameter_count();
        let rows = stmt
            .query_map(
                params_from_iter(std::iter::repeat_n(Value::Null, count)),
                |r| r.get::<_, String>(3),
            )
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            !rows
                .iter()
                .any(|row| row.contains("SCAN btcc_")
                    || row.contains("SCAN agent_task_graph_changes")),
            "{name}: {rows:?}"
        );
        plans.insert((*name).into(), serde_json::json!(rows));
    }
    let expected: serde_json::Value = serde_json::from_str(include_str!(
        "../fixtures/work-model-cutover/query-plans.json"
    ))
    .unwrap();
    assert_eq!(serde_json::Value::Object(plans), expected);
    Ok(())
}

// test-category: pure-logic
#[test]
fn downgrade_reimports_in_place_and_preserves_person_structure_edits()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let mut db = legacy_db();
    migrate(&mut db);
    let mapped = |db: &Connection| {
        db.query_row::<String, _, _>(
            "SELECT new_id FROM wm_legacy_map WHERE source='work' AND source_id='legacy-open'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    let original = mapped(&db);
    db.execute("UPDATE btcc_guided_works SET objective='Updated garden request' WHERE work_id='legacy-open'",[]).unwrap();
    migrate(&mut db);
    assert_eq!(mapped(&db), original);
    let work = store::read_work(&db, &original).unwrap();
    assert_eq!(work["title"], "Updated garden request");
    let chain: String = db
        .query_row(
            "SELECT id FROM wm_task_chains WHERE work_id=?1",
            [&original],
            |r| r.get(0),
        )
        .unwrap();
    let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
    store::edit_queue(
        &tx,
        &ctx(),
        &original,
        work["task_graph_revision"].as_i64().unwrap(),
        &[store::QueueEdit::SplitStack {
            chain_id: chain.clone(),
            index: 1,
        }],
    )
    .unwrap();
    tx.commit().unwrap();
    assert_eq!(
        store::read_work(&db, &original).unwrap()["revision"],
        work["revision"]
    );
    db.execute("UPDATE btcc_guided_works SET objective='Changed after user edit' WHERE work_id='legacy-open'",[]).unwrap();
    migrate(&mut db);
    let separate = mapped(&db);
    assert_ne!(separate, original);
    assert_eq!(
        store::read_work(&db, &separate).unwrap()["import_note"],
        "changed_after_downgrade"
    );
    assert_eq!(store::load_chain(&db, &chain).unwrap().chain.steps.len(), 4);
    let count: i64 = db
        .query_row("SELECT count(*) FROM wm_works", [], |r| r.get(0))
        .unwrap();
    migrate(&mut db);
    assert_eq!(mapped(&db), separate);
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM wm_works", [], |r| r.get(0))
            .unwrap(),
        count
    );
    Ok(())
}

// test-category: pure-logic
#[test]
fn managed_receipts_keep_original_ids_order_and_anchor_while_pending()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    use butler_work::cutover::{ManagedAdmission, accept};
    let mut db = legacy_db();
    let tx = store::Transaction::new(db.transaction().unwrap()).unwrap();
    cutover::begin(&tx, cutover::CutoverState::PostponedNoSpace).unwrap();
    let input = ManagedAdmission {
        message_id: "message".into(),
        session_id: "session".into(),
        turn_id: "turn".into(),
        body: "Keep the labels".into(),
        received_seq: 7,
        sender: serde_json::json!({"person":"app-user"}),
    };
    let id = accept(&tx, &input).unwrap();
    assert_eq!(accept(&tx, &input).unwrap(), id);
    assert_eq!(tx.query_row::<i64,_,_>("SELECT count(*) FROM wm_instructions WHERE idempotency_key='message' AND anchor_kind='turn' AND anchor_id='turn' AND received_seq=7 AND status='waiting_for_turn'",[],|r|r.get(0)).unwrap(),1);
    assert_eq!(
        tx.query_row::<i64, _, _>("SELECT count(*) FROM wm_works", [], |r| r.get(0))
            .unwrap(),
        0
    );
    let mut changed = input;
    changed.body = "Different message".into();
    assert!(accept(&tx, &changed).is_err());
    Ok(())
}

// test-category: pure-logic
#[test]
fn direction_receipts_keep_each_recipient_of_the_same_parent_message()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let mut db = legacy_db();
    db.execute_batch("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES('other-relation','legacy-session','legacy-turn','other-child','legacy-message',2,'Other child','2026-10-01');
        INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,created_at) VALUES('other-delegation','other-relation','other-task','other-turn','unresolved-source','{}','2026-10-01');
        INSERT INTO btcc_subsession_directions(instruction_id,relation_id,revision,source_parent_turn_id,source_message_id,instruction,status,created_at) VALUES('other-direction','other-relation',1,'legacy-turn','legacy-direction-message','Keep another label','pending','2026-10-01');").unwrap();
    migrate(&mut db);
    assert_eq!(db.query_row::<i64,_,_>("SELECT count(*) FROM wm_instructions WHERE json_extract(sender,'$.source_message_id')='legacy-direction-message'",[],|r|r.get(0)).unwrap(),2);
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(DISTINCT target_session_id) FROM wm_instructions",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        2
    );
    Ok(())
}
