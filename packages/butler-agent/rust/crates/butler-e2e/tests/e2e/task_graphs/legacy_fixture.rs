//! Historical sources captured from main 087e75624 with GraphBuilder::seed
//! (six failed graphs, five actions each) and history(40, 8). Legacy graph reads
//! stay measurable after live delegation switches to native Tasks and parts.
use super::*;
use base64::Engine;
use butler_e2e::e2e::{harness_error, scenario::Scenario};
use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde::Deserialize;
use serde_json::Value;
use std::{io::Read, path::Path};

#[derive(Deserialize)]
struct Fixture {
    source_commit: String,
    parent_session: String,
    graphs: Vec<String>,
    tables: Vec<Table>,
}

#[derive(Deserialize)]
struct Table {
    database: String,
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

pub(super) async fn seed(s: &Scenario, chat: &str) -> Result<(Vec<String>, u64), HarnessError> {
    super::super::work_model_cutover::completed(s).await?;
    let data = s.sandbox.data.clone();
    let chat = chat.to_owned();
    tokio::task::spawn_blocking(move || load(&data, &chat))
        .await
        .map_err(fixture::error)?
}

fn load(data: &Path, chat: &str) -> Result<(Vec<String>, u64), HarnessError> {
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(
        &include_bytes!("../../../fixtures/work-model-p14/legacy-graph-history.json.gz")[..],
    )
    .read_to_end(&mut raw)?;
    let source: Fixture = serde_json::from_slice(&raw)?;
    assert_eq!(source.source_commit, "087e75624f8d");
    assert_eq!(source.graphs.len(), 6);
    for database in ["runtime/session-store.sqlite", "agent-runtime/btcc.sqlite"] {
        let mut db = Connection::open(data.join(database))?;
        db.execute_batch("PRAGMA foreign_keys=ON")?;
        let tx = db.transaction()?;
        tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
        for table in source
            .tables
            .iter()
            .filter(|table| table.database == database)
        {
            insert(&tx, table)?;
        }
        tx.commit()?;
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    }
    // Preserve the captured identities and their signed admission snapshots.
    // Only the new App chat's reference to that historical owner is changed.
    let app = Connection::open(data.join("app-server/butler-client.sqlite"))?;
    assert_eq!(
        app.execute(
            "UPDATE chats SET runtime_session_hint=?1 WHERE id=?2",
            [&source.parent_session, chat]
        )?,
        1
    );
    let bytes = std::fs::metadata(data.join("agent-runtime/btcc.sqlite"))?.len();
    Ok((source.graphs, bytes))
}

fn insert(db: &Connection, table: &Table) -> Result<(), HarnessError> {
    let columns = table
        .columns
        .iter()
        .map(|name| quoted(name))
        .collect::<Vec<_>>()
        .join(",");
    let slots = vec!["?"; table.columns.len()].join(",");
    let mut statement = db.prepare(&format!(
        "INSERT INTO {} ({columns}) VALUES ({slots})",
        quoted(&table.table)
    ))?;
    for row in &table.rows {
        let values = row.iter().map(value).collect::<Result<Vec<_>, _>>()?;
        assert_eq!(statement.execute(params_from_iter(values))?, 1);
    }
    Ok(())
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn value(value: &Value) -> Result<SqlValue, HarnessError> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Number(number) if number.is_i64() => SqlValue::Integer(number.as_i64().unwrap()),
        Value::Number(number) => SqlValue::Real(
            number
                .as_f64()
                .ok_or_else(|| harness_error("fixture number"))?,
        ),
        Value::Object(object) => SqlValue::Blob(
            base64::engine::general_purpose::STANDARD
                .decode(
                    object["blob"]
                        .as_str()
                        .ok_or_else(|| harness_error("fixture blob"))?,
                )
                .map_err(fixture::error)?,
        ),
        _ => return Err(harness_error("fixture SQLite value")),
    })
}
