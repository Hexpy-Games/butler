//! Host-owned BTCC adapter; every SQL operation stays on its owning lane.
use butler_gateway::gateway::{
    AppWorkModelConflict, AppWorkModelEvent, AppWorkModelPort, AppWorkModelRequest,
    AppWorkModelResource, ApplicationFuture, GatewayApplicationError,
};
use butler_turn::btcc::{BtccStorage, StorageError};
use butler_work::{store, work_queries::Query};
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) struct AppWorkModel {
    storage: BtccStorage,
}
impl AppWorkModel {
    pub(crate) fn new(storage: BtccStorage) -> Self {
        Self { storage }
    }
}
impl AppWorkModelPort for AppWorkModel {
    fn execute(&self, request: AppWorkModelRequest) -> ApplicationFuture<Value> {
        let storage = self.storage.clone();
        Box::pin(async move {
            let AppWorkModelRequest {
                resource,
                id,
                input,
            } = request;
            if let Some(input) = input {
                // Same trusted local viewer as gateway/application/snapshot_input.rs.
                // Display-profile names are mutable presentation, not identities.
                let ctx = store::Context {
                    now: chrono::Utc::now().timestamp_millis(),
                    actor: json!({"person":"app-user","via":"app"}),
                };
                storage
                    .work_model_write(move |tx| {
                        store::write_api(tx, &ctx, store_resource(resource), &id, input)
                    })
                    .await
                    .map_err(error)
            } else {
                storage
                    .work_model_read(move |db| store::read_api(db, store_resource(resource), &id))
                    .await
                    .map_err(error)
            }
        })
    }
    fn project_scope(
        &self,
        resource: AppWorkModelResource,
        id: String,
    ) -> ApplicationFuture<String> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .work_model_read(move |db| {
                    store::api::project_scope(db, store_resource(resource), &id)
                })
                .await
                .map_err(error)
        })
    }
    fn changes(&self) -> Option<tokio::sync::watch::Receiver<()>> {
        Some(self.storage.subscribe_changes())
    }
    fn unpublished(&self, after: i64) -> ApplicationFuture<Vec<AppWorkModelEvent>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .work_model_read(move |db| {
                    let mut stmt = db.prepare(Query::UnpublishedOutbox.sql())?;
                    let rows = stmt
                        .query_map(rusqlite::params![after, 256], |r| {
                            Ok((
                                r.get::<_, i64>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, String>(2)?,
                            ))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    rows.into_iter()
                        .map(|(seq, topic, payload)| {
                            Ok(AppWorkModelEvent {
                                seq,
                                topic,
                                payload: serde_json::from_str(&payload)?,
                            })
                        })
                        .collect()
                })
                .await
                .map_err(error)
        })
    }
    fn published(&self, seqs: Vec<i64>) -> ApplicationFuture<()> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .work_model_write(move |tx| store::mark_outbox_published(tx, &seqs))
                .await
                .map_err(error)
        })
    }
}
fn error(error: StorageError) -> GatewayApplicationError {
    let StorageError::Port {
        code,
        message,
        source,
    } = &error
    else {
        return GatewayApplicationError::internal_from(error);
    };
    let status = match *code {
        "conflict" | "running" | "conversation_occupied" => 409,
        "work_model_not_found" => 404,
        "invalid_rank" | "cross_chat" | "work_model_invalid" => 400,
        _ => return GatewayApplicationError::internal_from(error),
    };
    let source = if *code == "conflict" {
        source
            .as_deref()
            .and_then(|s| s.downcast_ref::<store::Error>())
            .and_then(|e| match e {
                store::Error::Conflict { current } => current["revision"]
                    .as_i64()
                    .or(current["graph_revision"].as_i64()),
                _ => None,
            })
            .map(|revision| {
                Arc::new(AppWorkModelConflict { revision })
                    as Arc<dyn std::error::Error + Send + Sync>
            })
    } else {
        None
    };
    GatewayApplicationError::Public {
        status,
        code: (*code).into(),
        message: message.clone(),
        source,
    }
}

fn store_resource(resource: AppWorkModelResource) -> store::api::Resource {
    use AppWorkModelResource::{
        BacklogOrder, Canon, CreateEpic, CreatePlan, EditEpic, EditPlan, Epic, Plan, PlanOrder,
        Queue,
    };
    match resource {
        Queue => store::api::Resource::Queue,
        Canon => store::api::Resource::Canon,
        Plan => store::api::Resource::Plan,
        Epic => store::api::Resource::Epic,
        CreatePlan => store::api::Resource::CreatePlan,
        EditPlan => store::api::Resource::EditPlan,
        CreateEpic => store::api::Resource::CreateEpic,
        EditEpic => store::api::Resource::EditEpic,
        PlanOrder => store::api::Resource::PlanOrder,
        BacklogOrder => store::api::Resource::BacklogOrder,
    }
}
