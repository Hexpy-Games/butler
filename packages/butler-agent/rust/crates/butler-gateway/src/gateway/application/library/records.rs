//! Derived Library rows; callers own the enclosing App transaction.
use super::super::read_model;
use super::AppStorageError;
use butler_memory::cognition::analyze_search_field;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
pub(in crate::gateway::application) fn save(
    db: &Connection,
    item: &Value,
) -> Result<(), AppStorageError> {
    let mut item = item.clone();
    if let Some(time) = item["capturedAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    {
        item["capturedAt"] = json!(
            time.to_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
    }
    db.execute("INSERT INTO browser_library(id,kind,title,url,payload,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,payload=excluded.payload,created_at=excluded.created_at",
        params![item["id"].as_str(),item["kind"].as_str(),item["title"].as_str(),item["url"].as_str(),item.to_string(),item["capturedAt"].as_str()]).map_err(AppStorageError::sqlite)?;
    let rowid: i64 = db
        .query_row(
            "SELECT rowid FROM browser_library WHERE id=?1",
            [item["id"].as_str()],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    db.execute("DELETE FROM browser_library_fts WHERE rowid=?1", [rowid])
        .map_err(AppStorageError::sqlite)?;
    let field = ["title", "text", "url", "folder"]
        .iter()
        .filter_map(|key| item[*key].as_str())
        .collect::<Vec<_>>()
        .join(" ");
    db.execute(
        "INSERT INTO browser_library_fts(rowid,terms) VALUES(?1,?2)",
        params![rowid, analyze_search_field(&field)],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}
pub(in crate::gateway::application) fn document(
    db: &Connection,
    id: &str,
) -> Result<(), AppStorageError> {
    let row=db.query_row("SELECT id,owner_session_id,message_id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at FROM message_files WHERE id=?1",[id],|r|Ok(super::super::AppMessageFileSnapshot {
        id:r.get(0)?,owner_session_id:r.get(1)?,message_id:r.get(2)?,kind:r.get(3)?,mime_type:r.get(4)?,safe_name:r.get(5)?,size_bytes:r.get(6)?,sha256:r.get(7)?,storage_name:r.get(8)?,created_at:r.get(9)?
    })).map_err(AppStorageError::sqlite)?;
    let file = read_model::message_file_ref(&row)?;
    save(
        db,
        &json!({"id":format!("document-{}",row.id),"kind":"document","title":row.safe_name,"url":file.url,"file":file,"session":row.owner_session_id,"capturedAt":row.created_at}),
    )
}
pub(in crate::gateway::application) fn output(o: &butler_runtime::outputs::OutputSummary) -> Value {
    json!({"id":format!("output-{}",o.output_id),"output":o.output_id,"kind":"output","title":o.title,"url":format!("/outputs/{}/view",o.output_id),"session":o.session_id,"capturedAt":o.created_at})
}
