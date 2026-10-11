//! Visits and their search summaries on the existing App SQLite owner lane.
mod indexing;
mod query;
mod records;
pub(super) mod schema;
use super::super::{AppApplication, AppStorageError, app_error};
use crate::gateway::ApplicationFuture;
use serde_json::Value;

#[derive(Clone, Default)]
pub struct AppHistoryQuery {
    pub search: String,
    pub cursor: String,
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub butler_only: bool,
    pub limit: usize,
}
pub enum AppHistoryCommand {
    Record(Vec<Value>),
    UndoImport(String),
    Page(AppHistoryQuery),
    Suggestions(String),
    Delete(Vec<i64>),
    DeleteUrl(String),
    Clear {
        since: Option<i64>,
        until: i64,
        butler_only: bool,
    },
}
impl AppApplication {
    pub(in crate::gateway::application) fn history_owned(
        &self,
        command: AppHistoryCommand,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            match command {
                AppHistoryCommand::Page(q) => {
                    this.storage.read(move |db| query::page(db, &q)).await
                }
                AppHistoryCommand::Suggestions(q) => {
                    this.storage
                        .read(move |db| query::suggestions(db, &q))
                        .await
                }
                mutation => {
                    this.storage
                        .execute(move |db| {
                            let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                            let result = match mutation {
                                AppHistoryCommand::Record(visits) => records::record(&tx, &visits),
                                AppHistoryCommand::UndoImport(run) => {
                                    records::undo_import(&tx, &run)
                                }
                                AppHistoryCommand::Delete(ids) => records::delete_ids(&tx, &ids),
                                AppHistoryCommand::DeleteUrl(url) => records::delete_url(&tx, &url),
                                AppHistoryCommand::Clear {
                                    since,
                                    until,
                                    butler_only,
                                } => records::clear(&tx, since, until, butler_only),
                                AppHistoryCommand::Page(q) => query::page(&tx, &q),
                                AppHistoryCommand::Suggestions(q) => query::suggestions(&tx, &q),
                            }?;
                            tx.commit().map_err(AppStorageError::sqlite)?;
                            Ok(result)
                        })
                        .await
                }
            }
            .map_err(app_error)
        })
    }
}
