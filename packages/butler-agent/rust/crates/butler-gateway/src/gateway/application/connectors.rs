//! Compact events and rules share the App's SQLite lane and canonical queue.
mod delivery;
mod rows;
mod rules;
use super::{AppApplication, AppStorageError, events, storage::AppStorageCode};
use butler_core::{
    plugins::{ConnectorStore, ConnectorStoreRef as SharedStore, connector_failure as failure},
    plugins::{PluginError, PluginFuture},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::{Arc, Weak};
struct Store(Weak<AppApplication>);
impl AppApplication {
    pub fn connector_store(self: &Arc<Self>) -> SharedStore {
        Arc::new(Store(Arc::downgrade(self)))
    }
}
impl ConnectorStore for Store {
    fn execute(&self, operation: String, input: Value) -> PluginFuture<'_> {
        Box::pin(async move {
            let app = self
                .0
                .upgrade()
                .ok_or_else(|| failure("connectors_unavailable"))?;
            if operation == "deliver" {
                return app.deliver_connector(input).await;
            }
            let now = app.dependencies.identity_clock.now_iso();
            let subscribers = app.subscribers.clone();
            app.storage.execute(move |db|{
                match operation.as_str() {
                    "insert"=>rows::insert(db,input,&now),
                    "batch"=>rows::batch(db,&input,&now),
                    "ready"=>rows::ready(db,&input),
                    "pending"=>{let mut pending=rows::pending(db,&input)?;pending["now"]=now.clone().into();Ok(pending)},
                    "unfinished"=>rows::unfinished(db,&input),
                    "event"=>rows::event(db,&input),
                    "triage"=>rows::triage(db,&input),
                    "rules"=>rules::list(db,&input),
                    "rule"=>rules::get(db,&input),
                    "rule_set"=>rules::set(db,&subscribers,input,&now),
                    "rule_remove"=>rules::remove(db,&input),
                    "signal"=>rules::signal(db,&input,&now),
                    "plugin_remove"=>{
                        db.execute("DELETE FROM app_connector_rules WHERE connector LIKE ?1",[format!("{}/%",text(&input,"plugin")?)]).map_err(AppStorageError::sqlite)?;
                        Ok(json!({"ok":true}))
                    }
                    "access"=>Ok(json!({"read_only":super::settings::conversation_access_mode(db,"general")?==butler_turn::btcc::AccessMode::ReadOnly})),
                    _=>Err(invalid())
                }
            }).await.map_err(storage_error)
        })
    }
}
fn invalid() -> AppStorageError {
    AppStorageError::new(
        AppStorageCode::AppSchemaJsonFailed,
        "Invalid connector data.",
    )
}
fn storage_error(_: AppStorageError) -> PluginError {
    failure("connector_storage_failed")
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, AppStorageError> {
    v[key].as_str().ok_or_else(invalid)
}
fn parse(s: &str) -> Result<Value, AppStorageError> {
    serde_json::from_str(s).map_err(|_| invalid())
}
