//! Library commands and indexed reads on the existing App SQLite owner lane.
mod blocks;
mod groups;
mod item;
mod organize;
mod query;
mod records;
mod tags;
use super::{AppApplication, AppAssetCommand, AppStorageError, app_error};
use crate::gateway::ApplicationFuture;
pub use organize::AppLibraryChange;
pub use query::AppLibraryQuery;
pub(super) use records::{
    bookmark_in_folder, create_folder_groups, deliverable, document, editable_document, output,
    save,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
/// Explicit user (and agent tool) commands over App-owned Library records.
pub enum AppLibraryCommand {
    Document(super::AppDocumentCommand),
    /// Browsing visits share the existing App-owned browser command lane.
    History(crate::gateway::AppHistoryCommand),
    Page(AppLibraryQuery),
    /// Compact items across kinds for the agent's `library_search`.
    Search(AppLibraryQuery),
    Bookmark {
        url: String,
    },
    Save(Value),
    SaveDocumentBlock {
        document_id: String,
        index: usize,
    },
    SaveBlock {
        message_id: String,
        path: String,
    },
    Item {
        id: String,
    },
    Promote {
        file_id: String,
    },
    Delete {
        id: String,
    },
    /// A scrap's HTML copy, kept apart from the listed payload.
    Snapshot {
        id: String,
    },
    Groups {
        kind: String,
    },
    CreateGroup {
        kind: String,
        name: String,
    },
    UpdateGroup {
        id: String,
        name: Option<String>,
        position: Option<usize>,
    },
    DeleteGroup {
        id: String,
    },
    Change(AppLibraryChange),
    Tags,
    RenameTag {
        from: String,
        to: String,
    },
    DeleteTag {
        name: String,
    },
    Facets {
        kind: String,
        group: Option<String>,
    },
}
impl AppApplication {
    pub(super) fn library_owned(&self, command: AppLibraryCommand) -> ApplicationFuture<Value> {
        use AppLibraryCommand as C;
        match command {
            C::Document(command) => self.documents_owned(command),
            C::History(command) => self.history_owned(command),
            C::Page(q) => self.library_read(move |db| query::page(db, &q)),
            C::Search(q) => self.library_read(move |db| query::search(db, &q)),
            C::Bookmark { url } => self.library_read(move |db| lookup(db, &url)),
            C::Promote { file_id } => self.library_write(move |db| records::promote(db, &file_id)),
            C::SaveDocumentBlock { document_id, index } => {
                self.library_write(move |db| blocks::save_document(db, &document_id, index))
            }
            C::SaveBlock { message_id, path } => {
                self.library_write(move |db| blocks::save(db, &message_id, &path))
            }
            C::Item { id } => self.library_read(move |db| blocks::get(db, &id)),
            C::Save(item) => self.library_write(move |db| save_item(db, item)),
            C::Delete { id } => self.library_write(move |db| delete(db, &id)),
            C::Snapshot { id } => self.library_read(move |db| snapshot(db, &id)),
            C::Groups { kind } => self.library_read(move |db| groups::overview(db, &kind)),
            C::CreateGroup { kind, name } => {
                self.library_write(move |db| groups::create(db, &kind, &name))
            }
            C::UpdateGroup { id, name, position } => {
                self.library_write(move |db| groups::update(db, &id, name.as_deref(), position))
            }
            C::DeleteGroup { id } => self.library_write(move |db| groups::delete(db, &id)),
            C::Change(change) => self.library_write(move |db| organize::apply(db, &change)),
            C::Tags => self.library_read(tags::list),
            C::RenameTag { from, to } => self.library_write(move |db| tags::rename(db, &from, &to)),
            C::DeleteTag { name } => self.library_write(move |db| tags::delete(db, &name)),
            C::Facets { kind, group } => {
                self.library_read(move |db| tags::facets(db, &kind, group.as_deref()))
            }
        }
    }
    fn library_read<F>(&self, operation: F) -> ApplicationFuture<Value>
    where
        F: FnOnce(&Connection) -> Result<Value, AppStorageError> + Send + 'static,
    {
        let this = self.clone_handle();
        Box::pin(async move { this.storage.read(operation).await.map_err(app_error) })
    }
    /// One explicit command, one transaction on the owner lane.
    fn library_write<F>(&self, operation: F) -> ApplicationFuture<Value>
    where
        F: FnOnce(&Connection) -> Result<Value, AppStorageError> + Send + 'static,
    {
        let this = self.clone_handle();
        Box::pin(async move {
            let value = this
                .storage
                .execute(move |db| {
                    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                    let value = operation(&tx)?;
                    tx.commit().map_err(AppStorageError::sqlite)?;
                    Ok(value)
                })
                .await
                .map_err(app_error)?;
            this.assets_owned(AppAssetCommand::Sweep).await?;
            Ok(value)
        })
    }
}
fn lookup(db: &Connection, url: &str) -> Result<Value, AppStorageError> {
    let value = db
        .query_row(
            "SELECT payload FROM browser_library WHERE kind='bookmark' AND url=?1",
            [url],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(json!({"item": value.as_deref().map(item::parse).transpose()?}))
}
fn save_item(db: &Connection, mut item: Value) -> Result<Value, AppStorageError> {
    if item["kind"] == "bookmark" {
        use sha2::{Digest, Sha256};
        let url = url::Url::parse(item["url"].as_str().unwrap_or_default())
            .map_err(|e| {
                AppStorageError::new(super::storage::AppStorageCode::AppJsonFailed, e.to_string())
            })?
            .to_string();
        item["id"] = json!(format!("bookmark-{:x}", Sha256::digest(url.as_bytes())));
        item["url"] = json!(url);
    }
    // Listing pages read payloads only: a scrap's HTML copy lives in its own row.
    let html = item
        .get_mut("snapshot")
        .and_then(Value::as_object_mut)
        .and_then(|snapshot| snapshot.remove("html"));
    let saved = save(db, &item)?;
    save_snapshot(db, &item, html)?;
    Ok(saved)
}
pub(super) fn delete(db: &Connection, id: &str) -> Result<Value, AppStorageError> {
    let kind: Option<String> = db
        .query_row("SELECT kind FROM browser_library WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if kind.as_deref() == Some("doc") {
        super::documents::delete(db, id)?;
    }
    let sql = AppStorageError::sqlite;
    db.execute("DELETE FROM browser_library_fts WHERE rowid=(SELECT rowid FROM browser_library WHERE id=?1)",[id]).map_err(sql)?;
    db.execute("DELETE FROM browser_library_snapshot WHERE id=?1", [id])
        .map_err(sql)?;
    let tags = item::tag_keys(db, id)?;
    db.execute(
        "DELETE FROM browser_library_item_tag WHERE item_id=?1",
        [id],
    )
    .map_err(sql)?;
    for norm in tags {
        item::prune_tag(db, &norm)?;
    }
    db.execute("DELETE FROM browser_library WHERE id=?1", [id])
        .map_err(sql)?;
    Ok(json!({"ok":true}))
}
fn snapshot(db: &Connection, id: &str) -> Result<Value, AppStorageError> {
    let html = db
        .query_row(
            "SELECT html FROM browser_library_snapshot WHERE id=?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(json!({ "html": html }))
}
/// Stores, keeps or drops a scrap's HTML copy with its row (same transaction).
fn save_snapshot(
    db: &Connection,
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
