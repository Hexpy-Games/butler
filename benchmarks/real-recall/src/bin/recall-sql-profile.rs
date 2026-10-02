//! Replay private SELECTs with the product's bundled SQLite; compare an index.
use rusqlite::{Connection, OpenFlags, types::Value as SqlValue};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::Path, time::Instant};

type Error = Box<dyn std::error::Error>;

#[derive(Deserialize)]
struct Query {
    label: String,
    sql: String,
}

fn main() -> Result<(), Error> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 {
        return Err("usage: recall-sql-profile ORIGINAL_DB SCRATCH_DB QUERIES OUTPUT".into());
    }
    private_output(Path::new(&args[4]))?;
    let original_path = Path::new(&args[1]).canonicalize()?;
    let scratch_path = Path::new(&args[2]).canonicalize()?;
    if original_path == scratch_path {
        return Err("index experiment requires a distinct private scratch copy".into());
    }
    private_output(&scratch_path)?;
    let original = Connection::open_with_flags(original_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let scratch = Connection::open_with_flags(scratch_path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let queries: Vec<Query> = serde_json::from_slice(&std::fs::read(&args[3])?)?;
    let index = std::env::var_os("RECALL_PROFILE_NO_INDEX").is_none();
    let index_stats = if index {
        add_index(&scratch)?
    } else {
        Value::Null
    };
    let mut measurements = Vec::new();
    for query in queries {
        measurements.push(measure(&original, &scratch, &query)?);
    }
    std::fs::write(
        &args[4],
        serde_json::to_vec_pretty(&json!({
            "sqlite_version":rusqlite::version(), "index_stats":index_stats,
            "queries":measurements,
        }))?,
    )?;
    Ok(())
}

fn add_index(scratch: &Connection) -> Result<Value, Error> {
    let count_before: i64 =
        scratch.query_row("SELECT count(*) FROM memory_vector_units", [], |r| r.get(0))?;
    let start = Instant::now();
    let columns = if std::env::var_os("RECALL_PROFILE_JOB_FIRST").is_some() {
        "job_id,unit_id"
    } else {
        "unit_id,job_id"
    };
    scratch.execute_batch(&format!(
        "CREATE INDEX recall_perf_units_incomplete ON memory_vector_units
         ({columns}) WHERE state!='complete'",
    ))?;
    let build_ms = start.elapsed().as_secs_f64() * 1000.0;
    let count_after: i64 =
        scratch.query_row("SELECT count(*) FROM memory_vector_units", [], |r| r.get(0))?;
    if count_before != count_after {
        return Err("index creation changed row count".into());
    }
    Ok(json!({"unchanged_vector_rows":count_after,"build_ms":build_ms,"columns":columns}))
}

fn measure(original: &Connection, scratch: &Connection, query: &Query) -> Result<Value, Error> {
    if !query.sql.trim_start().to_uppercase().starts_with("SELECT")
        && !query.sql.trim_start().to_uppercase().starts_with("WITH")
    {
        return Err("only SELECT/CTE query replay is supported".into());
    }
    let expected = rows(original, &query.sql)?;
    let original_plan = plan(original, &query.sql)?;
    let indexed_plan = plan(scratch, &query.sql)?;
    let mut baseline_ms = Vec::new();
    let mut indexed_ms = Vec::new();
    for repeat in 0..3 {
        // Rotate order; validate complete rows and ordering on every timed run.
        for index in 0..2 {
            let indexed = (repeat + index) % 2 == 1;
            let start = Instant::now();
            let actual = rows(if indexed { scratch } else { original }, &query.sql)?;
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            if actual != expected {
                return Err("query result contents or order changed in index experiment".into());
            }
            if indexed {
                indexed_ms.push(ms);
            } else {
                baseline_ms.push(ms);
            }
        }
    }
    Ok(json!({"label":query.label,"returned_rows":expected.len(),
        "original_plan":original_plan,"indexed_plan":indexed_plan,
        "baseline_ms":baseline_ms,"indexed_ms":indexed_ms,
        "complete_rows_identical":true}))
}

fn rows(db: &Connection, sql: &str) -> Result<Vec<Vec<SqlValue>>, Error> {
    let mut statement = db.prepare(sql)?;
    let columns = statement.column_count();
    let mut cursor = statement.query([])?;
    let mut result = Vec::new();
    while let Some(row) = cursor.next()? {
        let values = (0..columns)
            .map(|column| row.get::<_, SqlValue>(column))
            .collect::<Result<Vec<_>, _>>()?;
        result.push(values);
    }
    Ok(result)
}

fn plan(db: &Connection, sql: &str) -> Result<Vec<String>, Error> {
    let mut statement = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
    let result = statement
        .query_map([], |row| row.get(3))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(result)
}

fn private_output(path: &Path) -> Result<(), Error> {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let parent = path
        .parent()
        .ok_or("output parent missing")?
        .canonicalize()?;
    if parent.starts_with(repository) {
        return Err(
            "private SQL outputs and writable scratch DB must be outside the worktree".into(),
        );
    }
    if path.exists()
        && path
            .extension()
            .is_some_and(|extension| extension == "json")
    {
        return Err("refusing to overwrite existing SQL measurements".into());
    }
    Ok(())
}
