//! The open-subtask read against the real upgraded schema: indexed sources
//! only, and its cost bounded by open children, not by retained history.
use super::*;
use butler_e2e::e2e::scenario::Setup;
use rusqlite::{Connection, params, params_from_iter, types::Value as SqlValue};

const SQL: &str = butler_turn::btcc::storage::OPEN_SUBTASKS_SQL;
/// The query's own CTE and table aliases; every table alias must be a SEARCH.
const CTES: [&str; 4] = ["tops", "subtree", "t", "s"];
const TABLES: [&str; 3] = ["r", "a", "u"];

#[tokio::test]
async fn open_subtask_read_is_indexed_and_bounded_by_open_children() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SUBTASKS-PLAN")?.start().await?;
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || check(&data))
        .await
        .map_err(|e| HarnessError(e.to_string()))??;
    s.finish().await
}

fn check(data: &std::path::Path) -> Result<(), HarnessError> {
    let db = butler_platform::sqlite::open(data.join("agent-runtime/btcc.sqlite"))?;
    let plan = plan(&db)?;
    for line in plan.lines() {
        let name = line.split_whitespace().nth(1).unwrap_or_default();
        if line.starts_with("SCAN ") {
            assert!(
                CTES.contains(&name) || line.contains("VIRTUAL TABLE") || line.contains("USING"),
                "unindexed source: {line}\n{plan}"
            );
        }
        // An automatic index is built by scanning the table on every read.
        if TABLES.contains(&name) {
            assert!(
                line.starts_with("SEARCH ") && !line.contains("AUTOMATIC"),
                "table not searched through a stored index: {line}\n{plan}"
            );
        }
    }
    let (parents, history, open) = seed(&db)?;
    let ids = serde_json::to_string(&parents).unwrap();
    let started = Instant::now();
    let rows = db
        .prepare(SQL)?
        .query_map([ids], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let elapsed = started.elapsed();
    // Complete and ordered: exactly the open children, parent by parent.
    assert_eq!(rows, open, "open subtasks");
    println!(
        "SUBTASK-QUERY parents={} relations={} open={} ms={:.3}",
        parents.len(),
        history + open.len(),
        open.len(),
        elapsed.as_secs_f64() * 1000.0
    );
    Ok(())
}

/// 600 visible chats with 20,000 finished children and three open ones.
fn seed(db: &Connection) -> Result<(Vec<String>, usize, Vec<(String, String)>), HarnessError> {
    let parents = (0..600)
        .map(|i| format!("seed-chat-{i:03}"))
        .collect::<Vec<_>>();
    let history = 20_000;
    db.execute_batch("BEGIN")?;
    let mut insert = db.prepare(
        "INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,\
         child_session_id,anchor_message_id,ordinal,safe_title,created_at,activity_role,\
         activity_worker_id,activity_terminal) VALUES(?1,?2,'turn',?3,'anchor',?4,'Seeded',?5,\
         'steward','steward-'||?1,?6)",
    )?;
    for i in 0..history {
        let id = format!("seed-done-{i:05}");
        insert.execute(params![
            id,
            parents[i % parents.len()],
            format!("child-{id}"),
            i,
            "2026-01-01T00:00:00Z",
            1
        ])?;
    }
    let mut open = Vec::new();
    for (index, parent) in [&parents[7], &parents[7], &parents[420]]
        .into_iter()
        .enumerate()
    {
        let id = format!("seed-open-{index}");
        insert.execute(params![
            id,
            parent,
            format!("child-{id}"),
            history + index,
            format!("2026-01-02T00:00:0{index}Z"),
            0
        ])?;
        open.push((parent.clone(), id));
    }
    drop(insert);
    db.execute_batch("COMMIT")?;
    Ok((parents, history, open))
}

fn plan(db: &Connection) -> Result<String, HarnessError> {
    let mut statement = db.prepare(&format!("EXPLAIN QUERY PLAN {SQL}"))?;
    let binds = vec![SqlValue::Null; statement.parameter_count()];
    let plan = statement
        .query_map(params_from_iter(binds), |r| r.get::<_, String>(3))?
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    eprintln!("SUBTASK-PLAN\n{plan}");
    Ok(plan)
}
