#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_canon::{work_queries, work_schema};
use rusqlite::{Connection, params_from_iter, types::Value};

// test-category: format-pin
#[test]
fn every_request_query_uses_its_index() {
    let db = Connection::open_in_memory().unwrap();
    work_schema::ensure(&db).unwrap();
    for query in work_queries::Query::all() {
        let mut stmt = db
            .prepare(&format!("EXPLAIN QUERY PLAN {}", query.sql()))
            .unwrap();
        let n = stmt.parameter_count();
        let plan = stmt
            .query_map(params_from_iter(std::iter::repeat_n(Value::Null, n)), |r| {
                r.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n");
        assert!(plan.contains(query.index()), "{query:?}: {plan}");
        assert!(!plan.contains("SCAN canon_"), "{query:?}: {plan}");
    }
}

// test-category: format-pin
#[test]
fn migration_rolls_back_every_change_on_invalid_canon_reference() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!(
        "../../butler-e2e/fixtures/work-model-p14/merged-schema.sql"
    ))
    .unwrap();
    db.execute_batch(include_str!(
        "../../butler-e2e/fixtures/work-model-p14/seed.sql"
    ))
    .unwrap();
    db.execute_batch("PRAGMA foreign_keys=OFF; UPDATE wm_works SET plan_id='missing' WHERE id='wk_canon'; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE").unwrap();
    assert!(work_schema::ensure(&db).is_err());
    assert!(
        !db.pragma_query_value::<bool, _>(None, "defer_foreign_keys", |r| r.get(0))
            .unwrap()
    );
    assert!(db.prepare("SELECT * FROM wm_tasks").is_ok());
    assert!(db.prepare("SELECT * FROM canon_epics").is_err());
    db.execute_batch("ROLLBACK").unwrap();
}
