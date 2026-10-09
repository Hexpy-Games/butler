//! Saved browser data uses the App SQLite owner lane, never a polling writer.
use super::{AppApplication, AppStorageError, app_error};
use crate::gateway::ApplicationFuture;
use rusqlite::params;
use serde_json::{Value, json};
impl AppApplication {
    pub(super) fn library_query(&self, kind: String, cursor: &str) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        let (time, id) = serde_json::from_str::<(String, String)>(cursor)
            .unwrap_or_else(|_| ("9999".into(), "~".into()));
        Box::pin(async move {
            this.storage.read(move |db| {
                let mut statement=db.prepare("SELECT payload FROM browser_library WHERE kind=?1 AND (created_at,id)<(?2,?3) ORDER BY created_at DESC,id DESC LIMIT 61").map_err(AppStorageError::sqlite)?;
                let mut items=statement.query_map(params![kind,time,id], |row| row.get::<_,String>(0)).map_err(AppStorageError::sqlite)?
                    .map(|row| row.map_err(AppStorageError::sqlite).and_then(|text| serde_json::from_str::<Value>(&text).map_err(|error| AppStorageError::new(super::storage::AppStorageCode::AppJsonFailed, error.to_string()))))
                    .collect::<Result<Vec<_>,_>>()?;
                let more=items.len()>60;
                if more {items.pop();}
                let next=if more {items.last().map(|item|json!([item["capturedAt"],item["id"]]).to_string())}else{None};
                Ok(json!({"items":items,"next_cursor":next}))
            }).await.map_err(app_error)
        })
    }
    pub(super) fn library_save(&self, item: Value) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.storage.execute(move |db| {
                db.execute("INSERT INTO browser_library(id,kind,title,url,payload,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,payload=excluded.payload",
                    params![item["id"].as_str(),item["kind"].as_str(),item["title"].as_str(),item["url"].as_str(),item.to_string(),item["capturedAt"].as_str()]).map_err(AppStorageError::sqlite)?;
                Ok(item)
            }).await.map_err(app_error)
        })
    }
    pub(super) fn library_delete(&self, id: String) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.storage
                .execute(move |db| {
                    db.execute("DELETE FROM browser_library WHERE id=?1", [id])
                        .map_err(AppStorageError::sqlite)?;
                    Ok(json!({"ok":true}))
                })
                .await
                .map_err(app_error)
        })
    }
}
