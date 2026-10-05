//! Owner-scale query/insert audit using the same bundled SQLite as the service.
use rusqlite::{Connection, params, params_from_iter, types::Value};
use std::{path::Path, time::Instant};

type Query = (String, String, Vec<Option<String>>);
type Rows = Vec<Vec<Value>>;
const INDEXES: [&str; 2] = [
    "idx_alias_postings_entity",
    "idx_alias_postings_scope_gram_node",
];

fn rows(db: &Connection, sql: &str, args: &[Option<String>]) -> Rows {
    let mut statement = db.prepare(sql).unwrap();
    let columns = statement.column_count();
    statement
        .query_map(params_from_iter(args), |row| {
            (0..columns).map(|column| row.get(column)).collect()
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn snapshot(db: &Connection, queries: &[Query]) -> Vec<(Rows, Rows)> {
    queries.iter().map(|(label, sql, args)| {
        let plan = rows(db, &format!("EXPLAIN QUERY PLAN {sql}"), args);
        assert!(!plan.iter().flatten().any(|value| matches!(value, Value::Text(text) if INDEXES.iter().any(|index| text.contains(index)))));
        let actual = rows(db, sql, args);
        let scoped = label == "selection" || label.contains("project") || label.contains("unassigned");
        let count = if scoped { 8_207 } else { 16_414 };
        let expected = if label == "delete" { Vec::new() }
        else if sql.starts_with("WITH") {
            vec![vec![Value::Text("ab".into()), Value::Integer(count)], vec![Value::Text("abc".into()), Value::Integer(count)]]
        } else {
            (0..16_414).filter(|n| !scoped || n % 2 == i32::from(label.contains("project"))).map(|n| {
                vec![Value::Text(format!("{n:036}")), Value::Text(format!("{n:064}")), Value::Text(format!("{:083}", n+1))]
            }).collect()
        };
            assert!(actual == expected, "complete ordered result mismatch: {label}");
        (plan, actual)
    }).collect()
}

fn insert_cost(db: &Connection) -> f64 {
    let started = Instant::now();
    db.execute_batch("BEGIN").unwrap();
    {
        let mut alias = db.prepare("INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?1,?2,?2,?2,?3,'new')").unwrap();
        let mut posting = db
            .prepare("INSERT INTO memory_alias_postings VALUES(?1,?2,?3,?4,'user',NULL)")
            .unwrap();
        for i in 0..1000 {
            let node = format!("{i:036}");
            let source = format!("{i:064}");
            let surface = format!("bench-{i:077}");
            alias.execute(params![node, surface, source]).unwrap();
            for gram in 0..54 {
                posting
                    .execute(params![format!("{gram:03}"), node, source, surface])
                    .unwrap();
            }
        }
    }
    db.execute_batch("COMMIT").unwrap();
    // 1,000 full aliases: elapsed seconds equals milliseconds per alias.
    let per_alias_ms = started.elapsed().as_secs_f64();
    let actual = rows(
        db,
        "SELECT * FROM memory_alias_postings WHERE surface_original LIKE 'bench-%' ORDER BY node_id,gram",
        &[],
    );
    let expected: Rows = (0..1000)
        .flat_map(|i| {
            (0..54).map(move |gram| {
                vec![
                    Value::Text(format!("{gram:03}")),
                    Value::Text(format!("{i:036}")),
                    Value::Text(format!("{i:064}")),
                    Value::Text(format!("bench-{i:077}")),
                    Value::Text("user".into()),
                    Value::Null,
                ]
            })
        })
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(
        rows(
            db,
            "SELECT COUNT(*) FROM memory_aliases WHERE surface_original LIKE 'bench-%'",
            &[]
        ),
        vec![vec![Value::Integer(1000)]]
    );
    db.execute_batch("DELETE FROM memory_alias_postings WHERE surface_original LIKE 'bench-%'; DELETE FROM memory_aliases WHERE surface_original LIKE 'bench-%'; PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    per_alias_ms
}

pub(super) fn run(directory: &Path) {
    let path = directory.join("graph.sqlite");
    let queries: Vec<Query> =
        serde_json::from_slice(&std::fs::read(directory.join("queries.json")).unwrap()).unwrap();
    assert_eq!(queries.len(), 63);
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "foreign_keys", "ON").unwrap();
    db.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    let before = snapshot(&db, &queries);
    let write_before = insert_cost(&db);
    let size_before = std::fs::metadata(&path).unwrap().len();
    let mut drops = Vec::new();
    for index in INDEXES {
        let free_before: i64 = db
            .pragma_query_value(None, "freelist_count", |row| row.get(0))
            .unwrap();
        let started = Instant::now();
        db.execute_batch(&format!("DROP INDEX IF EXISTS {index}"))
            .unwrap();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let wal = std::fs::metadata(path.with_extension("sqlite-wal"))
            .unwrap()
            .len();
        let free_after: i64 = db
            .pragma_query_value(None, "freelist_count", |row| row.get(0))
            .unwrap();
        drops.push(serde_json::json!({"index": index, "ms": ms, "wal_bytes": wal, "freed_pages": free_after-free_before}));
        assert!(
            snapshot(&db, &queries) == before,
            "plans/results changed after {index}"
        );
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    }
    let size_after = std::fs::metadata(&path).unwrap().len();
    assert_eq!(size_before, size_after);
    let free_after: i64 = db
        .pragma_query_value(None, "freelist_count", |row| row.get(0))
        .unwrap();
    let write_after = insert_cost(&db);
    assert_eq!(
        rows(&db, "SELECT COUNT(*) FROM memory_alias_postings", &[]),
        vec![vec![Value::Integer(886_340)]]
    );
    eprintln!(
        "ALIAS-DROP-NATIVE {}",
        serde_json::json!({
            "sqlite": rusqlite::version(), "postings": 886_340, "query_variants": queries.len(),
            "drops": drops, "file_bytes_before": size_before, "file_bytes_after": size_after,
        "freelist_pages_after": free_after, "alias_insert_ms_before": write_before,
        "alias_insert_ms_after": write_after, "vacuum": false,
        "page_size": db.pragma_query_value::<i64, _>(None, "page_size", |row| row.get(0)).unwrap(),
        "secure_delete": db.pragma_query_value::<i64, _>(None, "secure_delete", |row| row.get(0)).unwrap(),
        })
    );
}
