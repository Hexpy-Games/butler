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
        "wm_works_chain"
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
    db.execute_batch(
        "INSERT INTO wm_work_chains(id,session_id,created_at) VALUES('x','chat',0),('y','other',0);
        UPDATE wm_works SET chain_id='x',step_index=0,stack_position=0 WHERE id='a';
        UPDATE wm_works SET chain_id='y',step_index=0,stack_position=0 WHERE id='c';
        UPDATE wm_works SET chain_id='x',step_index=1,stack_position=0 WHERE id='d';",
    )
    .unwrap();
    assert!(
        db.execute("INSERT INTO wm_work_edges VALUES('a','c','x')", [])
            .is_err()
    );
    db.execute("INSERT INTO wm_work_edges VALUES('a','d','x')", [])
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
        } else if name == "task_rank" {
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
    for name in ["hold_reason", "held_by_work_id"] {
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
