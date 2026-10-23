#![allow(clippy::unwrap_used, reason = "format pins")]
use butler_work::{work_ids, work_schema};
use rusqlite::Connection;

pub(super) fn run1_upgrade_preserves_cutover_tasks_attempts_results_and_legacy_ids() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    db.execute_batch(include_str!("../../src/work_schema/entities.sql"))
        .unwrap();
    db.execute_batch(include_str!(
        "../../../butler-e2e/fixtures/work-model-p14/p22-run1-tasks.sql"
    ))
    .unwrap();
    db.execute_batch(include_str!("../../src/work_schema/specs.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../src/work_schema/execution.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../src/work_schema/support.sql"))
        .unwrap();
    db.execute_batch("INSERT INTO wm_works(id,scope_kind,scope_ref,title,visibility,origin,created_at,updated_at,created_by) VALUES('w','session','chat','Imported','private','migration',1,1,'{}');
      INSERT INTO wm_task_chains(id,work_id,created_at) VALUES('c','w',1);
      INSERT INTO wm_tasks(id,work_id,spec_ref,title,status,chain_id,step_index,stack_position,origin,created_at,updated_at,created_by) VALUES('t','w','{}','Imported task','pending','c',0,0,'migration',1,1,'{}');
      INSERT INTO wm_attempts(id,task_id,task_revision,spec_ref,session_id,lease_epoch,status,started_at) VALUES('a','t',0,'{}','s',0,'interrupted',1);
      INSERT INTO wm_results(id,revision,task_id,task_revision,attempt_id,spec_ref,body_ref,criterion_results_json,created_at) VALUES('r',1,'t',0,'a','{}','body','[]',1);
      INSERT INTO wm_legacy_map(source,source_id,new_id,source_hash,imported_revision,batch) VALUES('legacy','old','t','hash',0,'b');").unwrap();
    work_schema::ensure(&db).unwrap();
    let snapshot = |db: &Connection| -> (String, String, String, i64, Option<String>) {
        db.query_row("SELECT t.id,r.attempt_id,m.new_id,t.owner_epoch,t.reserved_session_id FROM wm_tasks t JOIN wm_results r ON r.task_id=t.id JOIN wm_legacy_map m ON m.new_id=t.id",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap()
    };
    let first = snapshot(&db);
    assert_eq!(first, ("t".into(), "a".into(), "t".into(), 0, None));
    work_schema::ensure(&db).unwrap();
    assert_eq!(snapshot(&db), first);
    assert!(
        db.prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query([])
            .unwrap()
            .next()
            .unwrap()
            .is_none()
    );
}

pub(super) fn ownership_columns_and_statement_order_are_enforced() {
    let db = Connection::open_in_memory().unwrap();
    work_schema::ensure(&db).unwrap();
    for (table, column) in [
        ("wm_tasks", "reserved_session_id"),
        ("wm_tasks", "owner_epoch"),
        ("wm_tasks", "handoff_to_session_id"),
        ("wm_attempts", "owner_epoch"),
        ("wm_holds", "reason"),
        ("wm_works", "started_at"),
    ] {
        assert!(
            db.query_row::<bool, _, _>(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                [table, column],
                |r| r.get(0)
            )
            .unwrap()
        );
    }
    db.execute_batch("INSERT INTO wm_works(id,scope_kind,scope_ref,title,visibility,origin,created_at,updated_at,created_by) VALUES('w','session','chat','W','private','chat',1,1,'{}');
      INSERT INTO wm_task_chains(id,work_id,created_at) VALUES('c','w',1);
      INSERT INTO wm_tasks(id,work_id,spec_ref,title,status,chain_id,step_index,stack_position,origin,created_at,updated_at,created_by) VALUES('t','w','{}','T','pending','c',0,0,'planner',1,1,'{}');").unwrap();
    assert!(
        db.execute("UPDATE wm_tasks SET status='running' WHERE id='t'", [])
            .is_err()
    );
    assert!(
        db.execute(
            "UPDATE wm_tasks SET handoff_to_session_id='next' WHERE id='t'",
            []
        )
        .is_err()
    );
    db.execute(
        "UPDATE wm_tasks SET reserved_session_id='reserved' WHERE id='t'",
        [],
    )
    .unwrap();
    assert!(
        db.execute(
            "UPDATE wm_tasks SET assignee_session_id='owner' WHERE id='t'",
            []
        )
        .is_err()
    );
    db.execute(
        "UPDATE wm_tasks SET reserved_session_id=NULL,assignee_session_id='owner' WHERE id='t'",
        [],
    )
    .unwrap();
    db.execute("UPDATE wm_tasks SET status='running' WHERE id='t'", [])
        .unwrap();
    assert!(
        db.execute("UPDATE wm_tasks SET owner_epoch=-1 WHERE id='t'", [])
            .is_err()
    );
    assert_eq!(
        work_ids::task_session_id("t"),
        work_ids::task_session_id("t")
    );
    assert_ne!(
        work_ids::task_session_id("t"),
        work_ids::task_session_id("other")
    );
}
