#![allow(clippy::unwrap_used, reason = "test assertions")]
#[path = "support/enum_columns.rs"]
mod enum_columns;
#[path = "support/vocabulary.rs"]
mod vocabulary;
use butler_work::{work_queries, work_schema};
use rusqlite::{Connection, params_from_iter, types::Value};

fn plan(db: &Connection, sql: &str) -> String {
    let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    let n = stmt.parameter_count();
    stmt.query_map(params_from_iter(std::iter::repeat_n(Value::Null, n)), |r| {
        r.get::<_, String>(3)
    })
    .unwrap()
    .collect::<Result<Vec<_>, _>>()
    .unwrap()
    .join("\n")
}
fn uses(db: &Connection, sql: &str, index: &str) -> bool {
    let p = plan(db, sql);
    p.contains(index) && !p.contains("SCAN wm_")
}

// test-category: format-pin
#[test]
fn every_request_query_uses_its_index() {
    let db = Connection::open_in_memory().unwrap();
    work_schema::ensure(&db).unwrap();
    for query in work_queries::Query::all() {
        let (sql, index) = (query.sql(), query.index());
        assert!(uses(&db, sql, index), "{sql}\n{}", plan(&db, sql));
    }
    assert!(!uses(
        &db,
        "SELECT * FROM wm_works WHERE title=?1",
        "wm_tasks_chain"
    ));
}

// test-category: format-pin
#[test]
fn schema_constraints_and_idempotency() {
    vocabulary::roundtrips_match_sql();
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    work_schema::ensure(&db).unwrap();
    let insert = "INSERT INTO wm_works(id,scope_kind,scope_ref,title,run_state,visibility,origin,home_session_id,created_by,created_at,updated_at) VALUES(?1,'session','chat','work',?2,?3,'chat','chat','{}',0,0)";
    assert!(db.execute(insert, ["bad", "unknown", "private"]).is_err());
    db.execute(insert, ["a", "idle", "canon"]).unwrap();
    assert!(db.execute(insert, ["b", "idle", "canon"]).is_err());
    db.execute(insert, ["c", "idle", "private"]).unwrap();
    db.execute(insert, ["d", "idle", "private"]).unwrap();
    let dispatch_index: String = db
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='wm_intents_child_dispatch_parent'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        dispatch_index.contains(
            "json_extract(payload_json,'$.delegation.parent_session_id'),state,created_at"
        )
    );
    assert!(dispatch_index.contains("WHERE kind='child_dispatch'"));
    assert!(!dispatch_index.contains("op_id"));
    db.execute_batch("DROP INDEX wm_intents_child_dispatch_parent;
        CREATE INDEX wm_intents_child_dispatch_parent ON wm_cross_db_intents(json_extract(payload_json,'$.delegation.parent_session_id'),state,created_at,op_id) WHERE kind='child_dispatch';").unwrap();
    work_schema::ensure(&db).unwrap();
    let hashed_tie: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_index_info('wm_intents_child_dispatch_parent') WHERE name='op_id')", [], |r| r.get(0)).unwrap();
    assert!(!hashed_tie);
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
        3,
        db.query_row::<i64, _, _>("SELECT count(*) FROM wm_works", [], |r| r.get(0))
            .unwrap()
    );
    db.execute_batch("INSERT INTO wm_task_chains(id,work_id,created_at) VALUES('x','a',0),('y','c',0);
        INSERT INTO wm_tasks(id,work_id,spec_ref,title,status,origin,chain_id,step_index,stack_position,created_at,updated_at,created_by)
        VALUES('ta','a','{}','A','pending','planner','x',0,0,0,0,'{}'),('tc','c','{}','C','pending','planner','y',0,0,0,0,'{}'),('td','a','{}','D','waiting','planner','x',1,0,0,0,'{}');").unwrap();
    assert!(
        db.execute(
            "INSERT INTO wm_task_edges(work_id,pred,succ,chain_id) VALUES('a','ta','tc','x')",
            []
        )
        .is_err()
    );
    db.execute(
        "INSERT INTO wm_task_edges(work_id,pred,succ,chain_id) VALUES('a','ta','td','x')",
        [],
    )
    .unwrap();
    for (table, column, values) in enum_columns::COLUMNS {
        rejects_unknown_enum(table, column);
        let sql = db
            .query_row::<String, _, _>(
                "SELECT sql FROM sqlite_schema WHERE name=?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            sql.contains(&format!("CHECK ({column} IN ({values}))")),
            "{table}.{column}"
        );
    }
}

// Build a valid row from schema metadata, then change exactly one enum value.
// Foreign keys are disabled here so only the column CHECK is under test.
fn rejects_unknown_enum(table: &str, column: &str) {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    work_schema::ensure(&db).unwrap();
    let fields = db
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut names = Vec::new();
    let mut values = Vec::new();
    for (name, kind, required, default) in fields {
        let vocabulary = enum_columns::COLUMNS
            .iter()
            .find(|(t, c, _)| *t == table && *c == name);
        let value = if let Some((_, _, choices)) = vocabulary {
            choices.split(',').next().unwrap().to_owned()
        } else if name == "visibility" {
            "'canon'".into()
        } else if let Some(default) = default {
            default
        } else if matches!(name.as_str(), "chain_id" | "step_index" | "stack_position")
            && table == "wm_tasks"
        {
            if kind == "INTEGER" {
                "0".into()
            } else {
                "'chain'".into()
            }
        } else if name == "part_rank" {
            "'V'".into()
        } else if name == "decided_at" {
            "1".into()
        } else if !required && name != "singleton" {
            "NULL".into()
        } else if kind == "INTEGER" {
            "1".into()
        } else if kind == "BLOB" {
            "X''".into()
        } else if name == "criterion_results_json" {
            "'[]'".into()
        } else if name.ends_with("_json")
            || matches!(
                name.as_str(),
                "spec_ref" | "reviewer" | "sender" | "created_by"
            )
        {
            "'{}'".into()
        } else {
            format!("'{name}'")
        };
        names.push(name);
        values.push(value);
    }
    if let Some(i) = names.iter().position(|n| n == "visibility") {
        values[i] = "'canon'".into();
    }
    for name in ["hold_reason", "held_by_task_id"] {
        if let Some(i) = names.iter().position(|n| n == name) {
            values[i] = "NULL".into();
        }
    }
    let insert = |values: &[String]| {
        format!(
            "INSERT INTO {table}({}) VALUES({})",
            names.join(","),
            values.join(",")
        )
    };
    db.execute_batch("SAVEPOINT valid").unwrap();
    db.execute_batch(&insert(&values)).unwrap();
    db.execute_batch("ROLLBACK TO valid; RELEASE valid")
        .unwrap();
    values[names.iter().position(|n| n == column).unwrap()] = "'unknown'".into();
    let error = db.execute_batch(&insert(&values)).unwrap_err();
    assert_eq!(
        error.sqlite_error().unwrap().extended_code,
        rusqlite::ffi::SQLITE_CONSTRAINT_CHECK,
        "{table}.{column}: {error}"
    );
}

// test-category: format-pin
#[test]
fn p1_upgrade_preserves_works_and_unrelated_tables_and_is_idempotent() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    db.execute_batch(include_str!(
        "../../butler-e2e/fixtures/work-model-p14/p1-shape.sql"
    ))
    .unwrap();
    db.execute_batch(include_str!(
        "../../butler-e2e/fixtures/work-model-p14/p1-values.sql"
    ))
    .unwrap();
    let before: Vec<serde_json::Value> = db
        .prepare("SELECT id FROM wm_works ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|id| butler_work::store::read_work(&db, &id.unwrap()).unwrap())
        .collect();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    work_schema::ensure(&db).unwrap();
    assert!(
        !db.pragma_query_value::<bool, _>(None, "defer_foreign_keys", |r| r.get(0))
            .unwrap()
    );
    db.execute_batch("COMMIT").unwrap();
    work_schema::ensure(&db).unwrap();
    for old in before {
        let current = butler_work::store::read_work(&db, old["id"].as_str().unwrap()).unwrap();
        for (column, value) in current.as_object().unwrap() {
            let expected = match column.as_str() {
                "task_graph_revision" => serde_json::json!(0),
                "failure_reason" => serde_json::Value::Null,
                "run_state"
                    if !matches!(
                        old[column].as_str(),
                        Some("done" | "cancelled" | "paused" | "stopped")
                    ) =>
                {
                    serde_json::json!("idle")
                }
                _ => old[column].clone(),
            };
            assert_eq!(*value, expected, "{}.{column}", old["id"]);
        }
    }
    for table in ["wm_tasks", "wm_results", "wm_attempts"] {
        assert_eq!(
            db.query_row::<i64, _, _>(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap(),
            0
        );
    }
    let session: (i64,String,String,i64,Option<String>,i64) = db.query_row("SELECT tier,phase,control_state,control_epoch,current_task_id,last_applied_seq FROM wm_session_exec", [],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap();
    assert_eq!(
        session,
        (2, "execution".into(), "running".into(), 17, None, 31)
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM wm_counts WHERE key='works' OR key LIKE 'run_state:%'",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count FROM wm_counts WHERE key='backlog_revision'",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        13
    );
    assert!(
        db.prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query([])
            .unwrap()
            .next()
            .unwrap()
            .is_none()
    );
    let fresh = Connection::open_in_memory().unwrap();
    work_schema::ensure(&fresh).unwrap();
    assert_eq!(schema(&db), schema(&fresh));
}
fn schema(db: &Connection) -> Vec<(String, Option<String>)> {
    db.prepare("SELECT name,sql FROM sqlite_schema WHERE name GLOB 'wm_*' ORDER BY name")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

// test-category: format-pin
#[test]
fn upgrade_rejects_foreign_key_violations_and_restores_deferral_on_error() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!(
        "../../butler-e2e/fixtures/work-model-p14/p1-shape.sql"
    ))
    .unwrap();
    db.execute_batch("PRAGMA foreign_keys=OFF; UPDATE wm_spec_nodes SET work_id='missing'; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE").unwrap();
    assert!(work_schema::ensure(&db).is_err());
    assert!(
        !db.pragma_query_value::<bool, _>(None, "defer_foreign_keys", |r| r.get(0))
            .unwrap()
    );
    // Schema/data changes rolled back at the migration savepoint, even inside an outer transaction.
    assert!(db.prepare("SELECT chain_id FROM wm_works").is_ok());
    db.execute_batch("ROLLBACK").unwrap();
}

// test-category: format-pin
#[test]
fn local_work_vocabulary_rejects_remote_status_sources_and_github_origins() {
    let db = Connection::open_in_memory().unwrap();
    work_schema::ensure(&db).unwrap();
    db.execute_batch("INSERT INTO wm_works(id,scope_kind,scope_ref,title,visibility,origin,created_by,created_at,updated_at) VALUES('local','project','project','title','canon','board','{}',1,1)").unwrap();
    for (column, value) in [("canon_status_source", "remote"), ("origin", "github")] {
        let error = db
            .execute(
                &format!("UPDATE wm_works SET {column}=?1 WHERE id='local'"),
                [value],
            )
            .unwrap_err();
        assert_eq!(
            error.sqlite_error().unwrap().extended_code,
            rusqlite::ffi::SQLITE_CONSTRAINT_CHECK
        );
    }
}
