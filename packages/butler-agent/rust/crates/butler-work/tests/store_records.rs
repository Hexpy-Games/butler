#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_work::{store::*, work_ids::*, work_schema, work_types::*};
use serde_json::json;
use store_support::*;
// test-category: pure-logic
#[test]
fn plan_work_spec_cas_and_immutable_publication() {
    let mut db = db();
    let tx = db.transaction().unwrap();
    let mut fields = PlanFields {
        title: "plan".into(),
        description: "description".into(),
        due_on: Some("2026-10-22".into()),
        status: PlanStatus::Open,
    };
    create_plan(
        &tx,
        &context(),
        "pl",
        "project",
        &fields,
        &Registration::Canon(UserAct::new("tester")),
    )
    .unwrap();
    fields.status = PlanStatus::Closed;
    edit_plan(&tx, &context(), "pl", 0, &fields).unwrap();
    assert!(
        matches!(edit_plan(&tx,&context(),"pl",0,&fields),Err(Error::Conflict{current}) if current["revision"]==1)
    );
    fields.status = PlanStatus::Open;
    assert_eq!(
        edit_plan(&tx, &context(), "pl", 1, &fields).unwrap()["status"],
        "open"
    );
    let node = NewSpecNode {
        id: "sp".into(),
        scope_kind: ScopeKind::Project,
        scope_ref: "project".into(),
        work_id: None,
        parent_node_id: None,
        concern_id: "concern".into(),
    };
    create_spec_node(&tx, &context(), &node, &Registration::Private).unwrap();
    let hash = put_body(&tx, "# Body\n").unwrap();
    assert_eq!(hash, put_body(&tx, "# Body\n").unwrap());
    let publication = Publication {
        revision: 1,
        body_hash: hash.clone(),
        parser_version: "structured-1".into(),
        authoring_instruction_id: None,
        criteria: vec![Criterion {
            id: "c".into(),
            part_id: "p".into(),
            text: "criterion".into(),
        }],
    };
    publish_spec(&tx, &context(), "sp", 0, &publication).unwrap();
    assert!(matches!(
        activate_spec(&tx, &context(), "sp", 0, None, 1),
        Err(Error::Conflict { .. })
    ));
    activate_spec(&tx, &context(), "sp", 1, None, 1).unwrap();
    assert!(
        matches!(activate_spec(&tx,&context(),"sp",2,Some(99),1),Err(Error::Conflict {current}) if current["active_revision"]==1)
    );
    let mut second = publication.clone();
    second.revision = 2;
    second.body_hash = put_body(&tx, "second body").unwrap();
    publish_spec(&tx, &context(), "sp", 2, &second).unwrap();
    assert_eq!(
        activate_spec(&tx, &context(), "sp", 3, Some(1), 2).unwrap()["active_revision"],
        2
    );
    assert_eq!(
        tx.query_row::<String, _, _>(
            "SELECT state FROM wm_spec_revisions WHERE node_id='sp' AND revision=1",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        "inactive"
    );
    let compressed: Vec<u8> = tx
        .query_row(
            "SELECT body FROM wm_spec_bodies WHERE hash=?1",
            [hash],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        zstd::stream::decode_all(compressed.as_slice()).unwrap(),
        b"# Body\n"
    );
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn home_rank_and_private_creation_have_typed_rules() {
    let mut db = db();
    work(&mut db, "a");
    work(&mut db, "b");
    let tx = db.transaction().unwrap();
    assign_home(&tx, &context(), "a", 0, Some("home")).unwrap();
    assert!(matches!(
        assign_home(&tx, &context(), "b", 0, Some("home")),
        Err(Error::ConversationOccupied)
    ));
    assert!(matches!(
        set_plan_rank(&tx, &context(), "a", 1, None, Some("A"), Some("A")),
        Err(Error::InvalidRank)
    ));
    assert!(matches!(
        edit_work(
            &tx,
            &context(),
            "a",
            0,
            &WorkFields::from_snapshot(&read_work(&tx, "a").unwrap()).unwrap()
        ),
        Err(Error::Conflict { .. })
    ));
    set_plan_rank(&tx, &context(), "a", 1, None, None, None).unwrap();
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn intent_replay_skips_domain_change_and_preserves_original_payload() {
    let mut db = db();
    let tx = db.transaction().unwrap();
    let first = with_intent(
        &tx,
        &context(),
        "op-2",
        "create_chat",
        &json!({"chat":"a"}),
        |_| Ok(()),
    )
    .unwrap();
    let replay = with_intent(&tx, &context(), "op-2", "different", &json!({}), |_| {
        panic!("replayed domain mutation")
    })
    .unwrap();
    assert_eq!(first, replay);
    record_intent(&tx, &context(), "op-1", "create_chat", &json!({})).unwrap();
    assert_eq!(pending_intents(&tx, "", 10).unwrap()[0]["op_id"], "op-1");
    mark_intent_applied(&tx, &context(), "op-1", 0).unwrap();
    assert!(matches!(
        mark_intent_applied(&tx, &context(), "op-1", 0),
        Err(Error::Conflict { .. })
    ));
    assert_eq!(pending_intents(&tx, "", 10).unwrap().len(), 1);
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn boot_marker_distinguishes_first_clean_and_crash_and_fences_old_boot() {
    let mut db = db();
    let tx = db.transaction().unwrap();
    assert_eq!(
        begin_boot(&tx, &context(), "first").unwrap(),
        PreviousShutdown::FirstBoot
    );
    mark_clean_shutdown(&tx, &context(), "first").unwrap();
    assert_eq!(
        begin_boot(&tx, &context(), "second").unwrap(),
        PreviousShutdown::Clean
    );
    assert_eq!(
        begin_boot(&tx, &context(), "third").unwrap(),
        PreviousShutdown::Crash
    );
    assert!(matches!(
        mark_clean_shutdown(&tx, &context(), "second"),
        Err(Error::Conflict { .. })
    ));
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn identifiers_pin_crockford_format_and_monotonic_clock_regression() {
    assert_eq!(
        encode(IdKind::Work, 0, [0; 10]).unwrap(),
        "wk_00000000000000000000000000"
    );
    assert_eq!(
        encode(IdKind::Plan, 0xffff_ffff_ffff, [255; 10]).unwrap(),
        "pl_7ZZZZZZZZZZZZZZZZZZZZZZZZZ"
    );
    assert!(encode(IdKind::Task, 1 << 48, [0; 10]).is_err());
    let mut generator = IdGenerator::default();
    let mut previous = String::new();
    for now in [100, 100, 99, 101, 101] {
        let id = generator.next(IdKind::Spec, now, [9; 10]).unwrap();
        assert!(id > previous);
        assert_eq!(id.len(), 29);
        previous = id;
    }
}
// test-category: format-pin
#[test]
fn every_store_statement_has_an_indexed_query_plan() {
    let db = db();
    for (name, sql) in sql::ALL {
        let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let n = stmt.parameter_count();
        let plan = stmt
            .query_map(
                rusqlite::params_from_iter(std::iter::repeat_n(rusqlite::types::Value::Null, n)),
                |r| r.get::<_, String>(3),
            )
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n");
        assert!(
            !plan.contains("SCAN wm_") && !plan.contains("SCAN a") && !plan.contains("SCAN t"),
            "{name}: {plan}"
        );
    }
}
// test-category: format-pin
#[test]
fn branch_one_database_upgrades_cas_columns_idempotently() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE wm_hold_decisions(id TEXT PRIMARY KEY,chain_id TEXT,failed_work_id TEXT,held_step_index INTEGER,question_message_id TEXT,decision TEXT,decided_at INTEGER);
    CREATE TABLE wm_cross_db_intents(op_id TEXT PRIMARY KEY,kind TEXT,payload_json TEXT,state TEXT,created_at INTEGER);").unwrap();
    work_schema::ensure(&db).unwrap();
    work_schema::ensure(&db).unwrap();
    for table in ["wm_hold_decisions", "wm_cross_db_intents"] {
        db.prepare(&format!("SELECT revision FROM {table}"))
            .unwrap();
    }
}
