#![allow(clippy::unwrap_used, reason = "test assertions")]
#[path = "support/enum_columns.rs"]
mod enum_columns;
#[path = "support/tags.rs"]
mod tags;
#[path = "support/vocabulary.rs"]
mod vocabulary;
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

// test-category: format-pin
#[test]
fn local_canon_vocabulary_rejects_remote_status_sources_and_github_origins() {
    let db = Connection::open_in_memory().unwrap();
    work_schema::ensure(&db).unwrap();
    db.execute_batch("INSERT INTO canon_epics(id,project_id,title,origin,created_by,created_at,updated_at) VALUES('local','project','title','board','{}',1,1)").unwrap();
    for (column, value) in [("canon_status_source", "remote"), ("origin", "github")] {
        let error = db
            .execute(
                &format!("UPDATE canon_epics SET {column}=?1 WHERE id='local'"),
                [value],
            )
            .unwrap_err();
        assert_eq!(
            error.sqlite_error().unwrap().extended_code,
            rusqlite::ffi::SQLITE_CONSTRAINT_CHECK
        );
    }
}

// test-category: format-pin
#[test]
fn schema_constraints_and_idempotency() {
    vocabulary::roundtrips_match_sql();
    tags::tag_keys_use_full_unicode_casefold_and_canonical_normalization();
    tags::tag_color_check_matches_the_design_system_vocabulary();
    tags::tag_schema_has_unique_names_cascading_links_and_idempotent_creation();
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    work_schema::ensure(&db).unwrap();
    for (table, column, choices) in enum_columns::COLUMNS {
        let sql: String = db
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name=?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            sql.contains(&format!("{column} IN ({choices})")),
            "{table}.{column}: {sql}"
        );
    }
    let insert = "INSERT INTO canon_epics(id,project_id,title,origin,created_at,updated_at,created_by) VALUES(?1,'project','Title',?2,1,1,'{}')";
    db.execute(insert, ["epic", "board"]).unwrap();
    for column in ["canon_status", "canon_status_source", "origin"] {
        let error = db
            .execute(
                &format!("UPDATE canon_epics SET {column}='unknown' WHERE id='epic'"),
                [],
            )
            .unwrap_err();
        assert_eq!(
            error.sqlite_error().unwrap().extended_code,
            rusqlite::ffi::SQLITE_CONSTRAINT_CHECK
        );
    }
    assert!(db.execute(insert, ["epic", "board"]).is_err());
    assert!(
        db.execute("UPDATE canon_epics SET plan_id='missing'", [])
            .is_err()
    );
    assert!(
        db.execute(
            "INSERT INTO canon_session_epics(session_id,epic_id,bound_at,bound_by,origin) VALUES('chat','missing',1,'{}','user')",
            []
        )
        .is_err()
    );
    assert!(
        db.execute(
            "INSERT INTO canon_plans VALUES('p','project','Plan','',NULL,'unknown',0,1,1,'{}')",
            []
        )
        .is_err()
    );
    db.execute_batch(
        "PRAGMA foreign_keys=OFF;
        CREATE TABLE unrelated_parent(id TEXT PRIMARY KEY);
        CREATE TABLE unrelated_child(id TEXT REFERENCES unrelated_parent(id));
        INSERT INTO unrelated_child VALUES('missing');
        INSERT INTO canon_session_epics(session_id,epic_id,bound_at,bound_by,origin) VALUES('chat','missing',1,'{}','user');
        PRAGMA foreign_keys=ON",
    )
    .unwrap();
    let before: i64 = db
        .query_row("PRAGMA schema_version", [], |r| r.get(0))
        .unwrap();
    work_schema::ensure(&db).unwrap();
    assert_eq!(
        before,
        db.query_row::<i64, _, _>("PRAGMA schema_version", [], |r| r.get(0))
            .unwrap()
    );
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM canon_epics", [], |r| r.get(0))
            .unwrap(),
        1
    );
    assert!(db.prepare("SELECT * FROM canon_session_queue").is_err());
    assert!(
        db.prepare("SELECT * FROM canon_session_queue_heads")
            .is_err()
    );
}
