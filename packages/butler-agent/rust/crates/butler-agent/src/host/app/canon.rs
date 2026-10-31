//! Host-owned BTCC adapter; every SQL operation stays on its owning lane.
mod canon_sidebar;
mod progress;
mod proposals;
mod queue;
mod requests;
use butler_canon::{store, work_queries::Query};
use butler_gateway::gateway::{
    AppCanonConflict, AppCanonEvent, AppCanonPort, AppCanonRequest, AppCanonResource,
    AppCanonTagExists, ApplicationFuture, GatewayApplicationError,
};
use butler_turn::btcc::{BtccStorage, StorageError};
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) struct AppCanon {
    storage: BtccStorage,
    ledger: progress::ProjectReader,
    feed_after: Arc<std::sync::atomic::AtomicI64>,
}
impl AppCanon {
    pub(crate) fn new(
        storage: BtccStorage,
        ledger: butler_ledger::project_ledger::ProjectLedger,
    ) -> Self {
        Self {
            storage,
            ledger: progress::ProjectReader::new(ledger),
            feed_after: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        }
    }
}
impl AppCanonPort for AppCanon {
    fn proposal(&self, action: String, input: Value) -> ApplicationFuture<Value> {
        proposals::execute(self.storage.clone(), action, input)
    }
    fn canon_operation(
        &self,
        operation: butler_gateway::gateway::AppCanonOperation,
    ) -> ApplicationFuture<Value> {
        canon_sidebar::execute(self.storage.clone(), self.ledger.clone(), operation)
    }
    fn session_epics(&self, sessions: Vec<String>) -> ApplicationFuture<Vec<Vec<String>>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .canon_read(move |db| {
                    let mut stmt = db.prepare(Query::ConversationWork.sql())?;
                    sessions
                        .into_iter()
                        .map(|session| {
                            Ok(stmt
                                .query_map([session], |r| r.get::<_, String>("id"))?
                                .collect::<rusqlite::Result<Vec<_>>>()?)
                        })
                        .collect()
                })
                .await
                .map_err(error)
        })
    }
    fn admit(
        &self,
        delegate: butler_gateway::gateway::AppCanonDelegate,
        capability: String,
    ) -> ApplicationFuture<Value> {
        requests::admit(self.storage.clone(), delegate, capability)
    }
    fn execute(&self, request: AppCanonRequest) -> ApplicationFuture<Value> {
        requests::execute(self.storage.clone(), self.ledger.clone(), request)
    }
    fn project_scope(&self, resource: AppCanonResource, id: String) -> ApplicationFuture<String> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .canon_read(move |db| store::api::project_scope(db, store_resource(resource), &id))
                .await
                .map_err(error)
        })
    }
    fn wake_replay(&self) {
        self.storage.notify_changes();
    }
    fn changes(&self) -> Option<tokio::sync::watch::Receiver<()>> {
        Some(self.storage.subscribe_changes())
    }
    fn reconcile(&self) -> ApplicationFuture<()> {
        Box::pin(progress::reconcile(
            self.storage.clone(),
            self.ledger.clone(),
            self.feed_after.clone(),
        ))
    }
    fn unpublished(&self, after: i64) -> ApplicationFuture<Vec<AppCanonEvent>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .canon_read(move |db| {
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
                            Ok(AppCanonEvent {
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
                .canon_write(move |tx| store::mark_outbox_published(tx, &seqs))
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
        "permission" => 403,
        "conflict" | "tag_exists" | "running" => 409,
        "work_model_not_found" => 404,
        "invalid_rank" | "work_model_invalid" => 400,
        _ => return GatewayApplicationError::internal_from(error),
    };
    let source = if *code == "tag_exists" {
        source
            .as_deref()
            .and_then(|s| s.downcast_ref::<store::Error>())
            .and_then(|e| match e {
                store::Error::TagExists { existing } => Some(Arc::new(AppCanonTagExists {
                    existing: existing.clone(),
                })
                    as Arc<dyn std::error::Error + Send + Sync>),
                _ => None,
            })
    } else if *code == "conflict" {
        source
            .as_deref()
            .and_then(|s| s.downcast_ref::<store::Error>())
            .and_then(|e| match e {
                store::Error::Conflict { current } => current["revision"]
                    .as_i64()
                    .or_else(|| current["graph_revision"].as_i64()),
                _ => None,
            })
            .map(|revision| {
                Arc::new(AppCanonConflict { revision }) as Arc<dyn std::error::Error + Send + Sync>
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

fn store_resource(resource: AppCanonResource) -> store::api::Resource {
    use AppCanonResource::{
        Activity, AllowGrant, BacklogOrder, Canon, CheckCriterion, Comment, CreateEpic, CreatePlan,
        CreateTag, DeleteEpic, DeleteTag, DenyGrant, EditEpic, EditPlan, EditTag, Epic,
        EpicProgress, Grants, List, Plan, PlanOrder, ProposeSpec, RevokeGrant, Spec, Tags,
    };
    match resource {
        List => store::api::Resource::List,
        Spec => store::api::Resource::Spec,
        Activity => store::api::Resource::Activity,
        Comment => store::api::Resource::Comment,
        ProposeSpec => store::api::Resource::ProposeSpec,
        CheckCriterion => store::api::Resource::CheckCriterion,
        Grants => store::api::Resource::Grants,
        AllowGrant => store::api::Resource::AllowGrant,
        DenyGrant => store::api::Resource::DenyGrant,
        RevokeGrant => store::api::Resource::RevokeGrant,
        Tags => store::api::Resource::Tags,
        CreateTag => store::api::Resource::CreateTag,
        EditTag => store::api::Resource::EditTag,
        DeleteTag => store::api::Resource::DeleteTag,
        Canon => store::api::Resource::Canon,
        Plan => store::api::Resource::Plan,
        Epic | EpicProgress => store::api::Resource::Epic,
        CreatePlan => store::api::Resource::CreatePlan,
        EditPlan => store::api::Resource::EditPlan,
        CreateEpic => store::api::Resource::CreateEpic,
        EditEpic => store::api::Resource::EditEpic,
        DeleteEpic => store::api::Resource::DeleteEpic,
        PlanOrder => store::api::Resource::PlanOrder,
        BacklogOrder => store::api::Resource::BacklogOrder,
    }
}
