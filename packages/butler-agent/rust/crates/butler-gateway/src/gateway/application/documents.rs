//! Transactional editable documents on the App's SQLite owner lane.
pub(super) mod context;
mod records;
mod writes;
use super::{AppApplication, AppStorageError, app_error, events};
use crate::gateway::ApplicationFuture;
pub(super) use records::{bind_reply, delete, has_deliverable, head, revision};
use rusqlite::Connection;
use serde_json::{Value, json};

pub enum AppDocumentCommand {
    Create(Value),
    Get(String),
    Save(String, Value),
    Revisions(String),
    Revision(String, i64),
    Restore(String, Value),
    Diff(String, i64),
    Seen(String, Value),
}
impl AppApplication {
    pub(super) fn documents_owned(&self, command: AppDocumentCommand) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        let subscribers = this.subscribers.clone();
        Box::pin(async move {
            if matches!(
                command,
                AppDocumentCommand::Get(_)
                    | AppDocumentCommand::Revision(_, _)
                    | AppDocumentCommand::Revisions(_)
                    | AppDocumentCommand::Diff(_, _)
            ) {
                return this
                    .storage
                    .read(move |db| run(db, command, &subscribers))
                    .await
                    .map_err(app_error);
            }
            let value = this
                .storage
                .execute(move |db| {
                    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                    let result = run(&tx, command, &subscribers)?;
                    tx.commit().map_err(AppStorageError::sqlite)?;
                    Ok(result)
                })
                .await
                .map_err(app_error)?;
            this.assets_owned(super::AppAssetCommand::Sweep).await?;
            Ok(value)
        })
    }
}
pub(super) fn run(
    db: &Connection,
    command: AppDocumentCommand,
    subscribers: &events::EventSubscribers,
) -> Result<Value, AppStorageError> {
    use AppDocumentCommand as C;
    match command {
        C::Get(id) => head(db, &id),
        C::Revision(id, rev) => revision(db, &id, rev),
        C::Revisions(id) => records::revisions(db, &id),
        C::Diff(id, from) => {
            let base = revision(db, &id, from)?;
            let head = head(db, &id)?;
            Ok(
                json!({"from":from,"to":head["rev"],"diff":butler_runtime::documents::diff(records::body(&base),records::body(&head))}),
            )
        }
        C::Seen(id, input) => {
            context::seen(db, &id, &input)?;
            Ok(json!({"ok":true}))
        }
        C::Create(input) => writes::create(db, &input, subscribers),
        C::Save(id, input) => writes::save(db, &id, &input, false, subscribers),
        C::Restore(id, mut input) => {
            let rev = records::positive(&input, "rev")?;
            let old = revision(db, &id, rev)?;
            input["body"] = old["body"].clone();
            input["author"] = json!("user");
            writes::save(db, &id, &input, true, subscribers)
        }
    }
}
