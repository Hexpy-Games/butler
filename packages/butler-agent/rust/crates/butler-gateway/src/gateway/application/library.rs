//! Library commands and indexed reads on the existing App SQLite owner lane.
mod records;
use super::{AppApplication, AppStorageError, app_error};
use crate::gateway::ApplicationFuture;
use butler_memory::cognition::analyze_search_query;
pub(super) use records::{document, output, save};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
/// Explicit user commands over App-owned Library records.
pub enum AppLibraryCommand {
    Page {
        kind: String,
        cursor: String,
        search: String,
    },
    Bookmark {
        url: String,
    },
    Save(Value),
    Delete {
        id: String,
    },
    /// A scrap's HTML copy, kept apart from the listed payload.
    Snapshot {
        id: String,
    },
}
impl AppApplication {
    pub(super) fn library_owned(&self, command: AppLibraryCommand) -> ApplicationFuture<Value> {
        match command {
            AppLibraryCommand::Page {
                kind,
                cursor,
                search,
            } => self.library_query(kind, &cursor, search),
            AppLibraryCommand::Bookmark { url } => self.library_lookup(url),
            AppLibraryCommand::Save(item) => self.library_save(item),
            AppLibraryCommand::Delete { id } => self.library_delete(id),
            AppLibraryCommand::Snapshot { id } => self.library_snapshot(id),
        }
    }
    pub(super) fn library_lookup(&self, url: String) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.storage.read(move |db| {
            let value=db.query_row("SELECT payload FROM browser_library WHERE kind='bookmark' AND url=?1",[url],|r|r.get::<_,String>(0)).optional().map_err(AppStorageError::sqlite)?;
            Ok(json!({"item":value.map(|s|serde_json::from_str::<Value>(&s)).transpose().map_err(|e|AppStorageError::new(super::storage::AppStorageCode::AppJsonFailed,e.to_string()))?}))
        }).await.map_err(app_error)
        })
    }
    pub(super) fn library_query(
        &self,
        kind: String,
        cursor: &str,
        search: String,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        let (time, id) = serde_json::from_str::<(String, String)>(cursor)
            .unwrap_or_else(|_| ("9999".into(), "~".into()));
        Box::pin(async move {
            this.storage.read(move |db| {
                let query=analyze_search_query(&search);
                if !search.trim().is_empty() && query.is_empty() { return Ok(json!({"items":[],"next_cursor":null})); }
                let sql=if query.is_empty() {
                    "SELECT payload FROM browser_library WHERE kind=?1 AND (created_at,id)<(?2,?3) AND ?4='' ORDER BY created_at DESC,id DESC LIMIT 61"
                }else{
                    "SELECT l.payload FROM browser_library_fts JOIN browser_library l ON l.rowid=browser_library_fts.rowid WHERE browser_library_fts MATCH ?4 AND l.kind=?1 AND (l.created_at,l.id)<(?2,?3) ORDER BY l.created_at DESC,l.id DESC LIMIT 61"
                };
                let mut statement=db.prepare(sql).map_err(AppStorageError::sqlite)?;
                let mut items=statement.query_map(params![kind,time,id,query],|row| row.get::<_,String>(0)).map_err(AppStorageError::sqlite)?
                    .map(|row|row.map_err(AppStorageError::sqlite).and_then(|s|serde_json::from_str::<Value>(&s).map_err(|e|AppStorageError::new(super::storage::AppStorageCode::AppJsonFailed,e.to_string())))).collect::<Result<Vec<_>,_>>()?;
                let more=items.len()>60; if more {items.pop();}
                let next=if more {items.last().map(|i|json!([i["capturedAt"],i["id"]]).to_string())}else{None};
                Ok(json!({"items":items,"next_cursor":next}))
            }).await.map_err(app_error)
        })
    }
    pub(super) fn library_save(&self, mut item: Value) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.storage
                .execute(move |db| {
                    if item["kind"] == "bookmark" {
                        use sha2::{Digest, Sha256};
                        let url = url::Url::parse(item["url"].as_str().unwrap_or_default())
                            .map_err(|e| {
                                AppStorageError::new(
                                    super::storage::AppStorageCode::AppJsonFailed,
                                    e.to_string(),
                                )
                            })?
                            .to_string();
                        item["id"] =
                            json!(format!("bookmark-{:x}", Sha256::digest(url.as_bytes())));
                        item["url"] = json!(url);
                    }
                    // Listing pages read payloads only: a scrap's HTML copy lives in its own row.
                    let html = item
                        .get_mut("snapshot")
                        .and_then(Value::as_object_mut)
                        .and_then(|snapshot| snapshot.remove("html"));
                    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                    save(&tx, &item)?;
                    save_snapshot(&tx, &item, html)?;
                    tx.commit().map_err(AppStorageError::sqlite)?;
                    Ok(item)
                })
                .await
                .map_err(app_error)
        })
    }
    pub(super) fn library_delete(&self, id: String) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.storage.execute(move |db| {
                let tx=db.savepoint().map_err(AppStorageError::sqlite)?;
                tx.execute("DELETE FROM browser_library_fts WHERE rowid=(SELECT rowid FROM browser_library WHERE id=?1)",[&id]).map_err(AppStorageError::sqlite)?;
                tx.execute("DELETE FROM browser_library_snapshot WHERE id=?1",[&id]).map_err(AppStorageError::sqlite)?;
                tx.execute("DELETE FROM browser_library WHERE id=?1",[id]).map_err(AppStorageError::sqlite)?;
                tx.commit().map_err(AppStorageError::sqlite)?; Ok(json!({"ok":true}))
            }).await.map_err(app_error)
        })
    }
    pub(super) fn library_snapshot(&self, id: String) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.storage
                .read(move |db| {
                    let html = db
                        .query_row(
                            "SELECT html FROM browser_library_snapshot WHERE id=?1",
                            [id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()
                        .map_err(AppStorageError::sqlite)?;
                    Ok(json!({ "html": html }))
                })
                .await
                .map_err(app_error)
        })
    }
}
/// Stores, keeps or drops a scrap's HTML copy with its row (same transaction).
fn save_snapshot(
    db: &rusqlite::Connection,
    item: &Value,
    html: Option<Value>,
) -> Result<(), AppStorageError> {
    let id = item["id"].as_str().unwrap_or_default();
    match html {
        Some(Value::String(html)) => db.execute(
            "INSERT INTO browser_library_snapshot(id,html) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET html=excluded.html",
            params![id, html],
        ),
        _ if item["snapshot"].is_null() => db.execute(
            "DELETE FROM browser_library_snapshot WHERE id=?1",
            [id],
        ),
        _ => Ok(0),
    }
    .map(|_| ())
    .map_err(AppStorageError::sqlite)
}
