//! Sign-in entries, site grants and fill audit in the App database. No secret
//! is ever stored here: passwords live only in the OS credential store.
mod records;
use super::{AppApplication, app_error};
use crate::gateway::ApplicationFuture;
use serde_json::Value;

/// One saved sign-in to add, or to merge from an import.
#[derive(Clone, Debug)]
pub struct AppSignInUpsert {
    pub site: String,
    pub origin: String,
    pub username: String,
    /// `manual` replaces the site's entry; `import` keeps an entry for another account.
    pub source: String,
}

/// Explicit sign-in commands over the App SQLite owner lane.
pub enum AppSignInCommand {
    /// Settings rows: one per site with an entry, a grant or a standing allow.
    List,
    /// The entry for a site, for a fill.
    Lookup {
        site: String,
    },
    Entry {
        id: String,
    },
    /// Adds or merges; answers `{id, action: inserted|updated|replaced|skipped}`.
    Upsert(AppSignInUpsert),
    /// Undoes an insert whose secret could not be stored.
    Forget {
        id: String,
    },
    SetPolicy {
        id: String,
        policy: String,
    },
    Delete {
        id: String,
    },
    SetAllConversations {
        site: String,
        value: bool,
    },
    /// Revokes every conversation grant on the site and its standing allow.
    Revoke {
        site: String,
    },
    /// Sites and frame grants a conversation's turn may use.
    Grants {
        session: String,
        turn: Option<String>,
    },
    Grant {
        session: String,
        site: String,
        frame_site: String,
        source: String,
    },
    Audit {
        entry_id: String,
        session: String,
        turn: String,
        origin: String,
        result: String,
    },
    /// Records the conversation whose grants a schedule run may use.
    ScheduleSource {
        automation_id: String,
        source_session: String,
    },
    /// Saves imported bookmarks that are not saved yet; answers counts.
    ImportBookmarks(Vec<Value>),
    /// Counts only, never values.
    ImportSummary {
        source: String,
        kind: String,
        counts: Value,
    },
}

/// Sign-in entries, site grants and audit rows (never secrets).
pub trait GatewaySignIns: Send + Sync {
    fn signins(&self, command: AppSignInCommand) -> ApplicationFuture<Value> {
        let _ = command;
        Box::pin(async { Err(super::GatewayApplicationError::internal()) })
    }
}

impl GatewaySignIns for AppApplication {
    fn signins(&self, command: AppSignInCommand) -> ApplicationFuture<Value> {
        self.signins_owned(command)
    }
}

impl AppApplication {
    fn signins_owned(&self, command: AppSignInCommand) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        let now = self.dependencies.identity_clock.now_iso();
        let id = self.dependencies.identity_clock.new_uuid();
        Box::pin(async move {
            let read = matches!(
                command,
                AppSignInCommand::List
                    | AppSignInCommand::Lookup { .. }
                    | AppSignInCommand::Entry { .. }
                    | AppSignInCommand::Grants { .. }
            );
            if read {
                this.storage
                    .read(move |db| records::read(db, command))
                    .await
                    .map_err(app_error)
            } else {
                this.storage
                    .execute(move |db| {
                        let tx = db.savepoint().map_err(super::AppStorageError::sqlite)?;
                        let value = records::write(&tx, command, &now, &id)?;
                        tx.commit().map_err(super::AppStorageError::sqlite)?;
                        Ok(value)
                    })
                    .await
                    .map_err(app_error)
            }
        })
    }
}
