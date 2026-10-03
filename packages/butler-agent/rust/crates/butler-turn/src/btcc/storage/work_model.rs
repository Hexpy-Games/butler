//! Work-model SQL on the existing BTCC transaction lane; no polling owner.
mod child;
mod coverage;
mod creation;
pub(in crate::btcc::storage) use child::assign_child;
mod graph;
mod reads;
mod tasks;

use super::BtccStorage;
use crate::btcc::work_model::{check, error};
use crate::btcc::{BtccError, work_model::*};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, BtccError>;

#[derive(Clone)]
pub struct WorkModelRepository {
    storage: BtccStorage,
    operations: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

pub struct Admission {
    pub receipt: Option<Value>,
}

impl WorkModelRepository {
    pub fn new(storage: BtccStorage) -> Self {
        Self {
            storage,
            operations: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    pub fn operation_count(&self) -> u64 {
        self.operations.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub async fn enabled(&self) -> Result<bool> {
        self.lane(|db| {
            db.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='wm_mode')",
                [],
                |r| r.get(0),
            )
            .map_err(sql)
        })
        .await
    }

    async fn lane<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.operations
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.storage
            .execute(move |db| Ok(operation(db)))
            .await
            .map_err(BtccError::from)?
    }

    pub async fn enable(&self, enabled: bool) -> Result<bool> {
        self.lane(move |db| {
            let exists = db.query_row("SELECT 1 FROM sqlite_schema WHERE name='wm_mode'", [], |_| Ok(()))
                .optional().map_err(sql)?.is_some();
            if exists { check(enabled, "work_model_writer_epoch_required")?; return Ok(true); }
            if !enabled { return Ok(false); }
            let history: i64 = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_turns) OR EXISTS(SELECT 1 FROM btcc_guided_works)", [], |row| row.get(0)).map_err(sql)?;
            check(history == 0, "work_model_requires_empty_installation")?;
            let tx = db.transaction().map_err(sql)?;
            tx.execute_batch(include_str!("work_model/schema.sql")).map_err(sql)?;
            tx.execute("INSERT INTO wm_mode VALUES(1,1)", []).map_err(sql)?;
            tx.execute("UPDATE agent_storage_activation_marker SET marker_json=json_set(marker_json,'$.storageContract','work-model-core-v1')", [])
                .map_err(sql)?;
            tx.commit().map_err(sql)?;
            Ok(true)
        }).await
    }

    pub async fn admit(
        &self,
        session: String,
        request: WorkModelRequest,
        hash: String,
    ) -> Result<Admission> {
        self.lane(move |db| {
            check(!request.idempotency_key.trim().is_empty(), "idempotency_key_required")?;
            let admitted: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE turn_id=?1 AND session_id=?2)",
                params![request.instruction_id, session], |row| row.get(0)).map_err(sql)?;
            check(admitted, "instruction_scope_invalid")?;
            let prior: Option<(String, Option<String>)> = db.query_row(
                "SELECT payload_hash,receipt_json FROM wm_intents WHERE session_id=?1 AND operation_key=?2",
                params![session, request.idempotency_key], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(sql)?;
            if let Some((expected, receipt)) = prior {
                check(hash == expected, "idempotency_conflict")?;
                return Ok(Admission { receipt: receipt.map(|s| decode(&s)).transpose()? });
            }
            db.execute("INSERT INTO wm_intents(session_id,operation_key,instruction_id,payload_hash,request_json,receipt_json) VALUES(?1,?2,?3,?4,?5,NULL)",
                params![session,request.idempotency_key,request.instruction_id,hash,encode(&audit_request(&request)?)?]).map_err(sql)?;
            Ok(Admission { receipt: None })
        }).await
    }

    pub async fn commit(
        &self,
        session: String,
        request: WorkModelRequest,
        hash: String,
        prepared: Result<Option<Creation>>,
    ) -> Result<Value> {
        self.lane(move |db| {
            let tx = db.transaction().map_err(sql)?;
            let prior: Option<String> = tx.query_row("SELECT receipt_json FROM wm_intents WHERE session_id=?1 AND operation_key=?2",
                params![session,request.idempotency_key], |row| row.get(0)).map_err(sql)?;
            if let Some(prior) = prior { return decode(&prior); }
            tx.execute_batch("SAVEPOINT wm_operation").map_err(sql)?;
            let result = prepared.and_then(|creation| apply(&tx, &session, &request, creation));
            let (mut receipt, succeeded) = match result {
                Ok(value) => { tx.execute_batch("RELEASE wm_operation").map_err(sql)?; (value, true) }
                Err(failure) => {
                    tx.execute_batch("ROLLBACK TO wm_operation; RELEASE wm_operation").map_err(sql)?;
                    (json!({"ok":false,"error":{"code":failure.code(),"message":failure.message()}}), false)
                }
            };
            let plan = reads::plan(&tx, &session)?;
            tx.execute("INSERT INTO wm_audit(scope_id,plan_id,session_id,instruction_id,operation_key,payload_hash,request_json,result_json,created_at) VALUES(?9,?2,?1,?3,?4,?5,?6,?7,?8)",
                params![session,plan.as_ref().map(|p| &p.id),request.instruction_id,request.idempotency_key,hash,encode(&audit_request(&request)?)?,encode(&receipt)?,chrono::Utc::now().to_rfc3339(),plan.as_ref().map_or(session.as_str(),|p|p.scope_id.as_str())]).map_err(sql)?;
            let seq = tx.last_insert_rowid();
            set(&mut receipt,"event_seq",json!(seq))?;
            set(&mut receipt,"operation_ids",json!([request.idempotency_key]))?;
            if succeeded && let Some(plan) = plan {
                tx.execute("UPDATE wm_plans SET event_seq=?1,revision=revision+CASE WHEN event_seq=0 THEN 0 ELSE 1 END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE scope_id=?2 AND id=?3", params![seq,plan.scope_id,plan.id]).map_err(sql)?;
                tx.execute("INSERT INTO wm_outbox VALUES(?1,?2)", params![seq,encode(&json!({"kind":"work_model.changed","plan_id":plan.id,"tier":plan.tier,"graph_revision":plan.graph_revision,"event_seq":seq}))?]).map_err(sql)?;
            }
            tx.execute("UPDATE wm_intents SET receipt_json=?1 WHERE session_id=?2 AND operation_key=?3",
                params![encode(&receipt)?,session,request.idempotency_key]).map_err(sql)?;
            tx.commit().map_err(sql)?;
            Ok(receipt)
        }).await
    }

    pub async fn creation_gate(&self, session: String, publish: bool) -> Result<()> {
        self.lane(move |db| {
            if let Some(plan) = reads::plan(db, &session)? {
                check(
                    plan.owner_session_id == session,
                    "spec_authoring_scope_invalid",
                )?;
                check(
                    publish || plan.status == "completed",
                    "in_use_spec_replan_unavailable",
                )?;
            }
            Ok(())
        })
        .await
    }

    pub async fn pending_intents(&self, after: (String, String)) -> Result<Vec<Value>> {
        self.lane(move |db| {
            let mut statement=db.prepare_cached("SELECT session_id,operation_key,request_json,payload_hash FROM wm_intents WHERE receipt_json IS NULL AND (session_id,operation_key)>(?1,?2) ORDER BY session_id,operation_key LIMIT 50").map_err(sql)?;
            let rows=statement.query_map(params![after.0,after.1],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).map_err(sql)?;
            rows.map(|row|{let(session,key,request,hash)=row.map_err(sql)?;Ok(json!({"session":session,"key":key,"request":decode::<Value>(&request)?,"hash":hash}))}).collect()
        }).await
    }

    pub async fn scope(&self, session: String) -> Result<String> {
        self.lane(move |db| Ok(reads::plan(db, &session)?.map_or(session, |p| p.scope_id)))
            .await
    }

    pub async fn outbox(&self, after: u64) -> Result<Value> {
        self.lane(move |db| {
            let mut statement = db
                .prepare_cached(
                    "SELECT event_json FROM wm_outbox WHERE seq>?1 ORDER BY seq LIMIT 500",
                )
                .map_err(sql)?;
            let rows = statement
                .query_map([after], |r| r.get::<_, String>(0))
                .map_err(sql)?;
            Ok(json!(
                rows.map(|row| decode::<Value>(&row.map_err(sql)?))
                    .collect::<Result<Vec<_>>>()?
            ))
        })
        .await
    }

    pub async fn summary(&self, session: String, cursor: Option<String>) -> Result<Value> {
        self.lane(move |db| reads::page(db, &session, cursor.as_deref(), false))
            .await
    }

    pub async fn graph(&self, session: String, cursor: Option<String>) -> Result<Value> {
        self.lane(move |db| reads::page(db, &session, cursor.as_deref(), true))
            .await
    }

    pub async fn graph_plan(&self, id: String, cursor: Option<String>) -> Result<Value> {
        self.lane(move |db| reads::page_plan(db, &id, cursor.as_deref()))
            .await
    }

    pub async fn ancestors(&self, session: String, node: String) -> Result<Vec<SpecRef>> {
        self.lane(move |db| reads::ancestors(db, &session, &node))
            .await
    }

    pub async fn operation_specs(
        &self,
        session: String,
        command: WorkModelCommand,
    ) -> Result<Vec<SpecRef>> {
        self.lane(move |db| {
            let plan = reads::require_plan(db, &session)?;
            let node = match command {
                WorkModelCommand::Start { task_id, .. }
                | WorkModelCommand::Submit { task_id, .. }
                | WorkModelCommand::Review { task_id, .. }
                | WorkModelCommand::Complete { task_id, .. }
                | WorkModelCommand::Remove { task_id, .. }
                | WorkModelCommand::Step { task_id, .. } => {
                    tasks::load(db, &plan.scope_id, &plan.id, &task_id)?
                        .spec_ref
                        .node_id
                }
                _ => plan.root_node_id,
            };
            reads::ancestors(db, &session, &node)
        })
        .await
    }

    pub async fn delegation_gate(&self, session: String) -> Result<()> {
        self.lane(move |db| {
            let plan = reads::require_plan(db, &session).map_err(|_| error("tier_two_required"))?;
            check(plan.tier == 2, "tier_two_required")
        })
        .await
    }

    pub async fn delegation_task(&self, session: String) -> Result<TaskCard> {
        self.lane(move |db| {
            let plan = reads::require_plan(db, &session)?;
            check(plan.tier == 2, "tier_two_required")?;
            let current: Option<String> = db
                .query_row(
                    "SELECT current_task_id FROM wm_sessions WHERE session_id=?1",
                    [&session],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            let task = tasks::load(
                db,
                &plan.scope_id,
                &plan.id,
                &current.ok_or_else(|| error("running_task_required"))?,
            )?;
            check(
                task.status == "running" && task.assignee_session_id.as_deref() == Some(&session),
                "running_task_required",
            )?;
            check(
                session == plan.owner_session_id || task.allow_nested_delegation,
                "nested_delegation_grant_required",
            )?;
            Ok(task)
        })
        .await
    }

    pub async fn child_result(&self, session: String) -> Result<Vec<String>> {
        self.lane(move |db| {
            let plan = reads::require_plan(db, &session)?;
            let task: Option<String> = db.query_row("SELECT json_extract(packet_json,'$.task_id') FROM btcc_subsession_delegations d JOIN btcc_session_relations r ON r.relation_id=d.relation_id WHERE r.child_session_id=?1", [&session], |r| r.get(0)).optional().map_err(sql)?;
            let task = tasks::load(db, &plan.scope_id, &plan.id, &task.ok_or_else(|| error("assigned_task_required"))?)?;
            check(task.status == "awaiting_review" || task.status=="completed", "task_submission_required")?;
            Ok(task.evidence_refs)
        }).await
    }

    pub async fn effect_grant(
        &self,
        session: String,
        turn: String,
    ) -> Result<WorkModelEffectGrant> {
        let repository = self.clone();
        self.lane(move |db| {
            let admitted: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE session_id=?1 AND turn_id=?2)",
                    params![session, turn],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            check(admitted, "instruction_scope_invalid")?;
            let (scope_id, revision_id, objective) = if let Some(plan) =
                reads::plan(db, &session)?.filter(|p| p.status != "completed")
            {
                let current: Option<String> = db
                    .query_row(
                        "SELECT current_task_id FROM wm_sessions WHERE session_id=?1",
                        [&session],
                        |r| r.get(0),
                    )
                    .map_err(sql)?;
                let task = tasks::load(
                    db,
                    &plan.scope_id,
                    &plan.id,
                    &current.ok_or_else(|| error("running_task_required"))?,
                )?;
                check(
                    task.status == "running"
                        && task.assignee_session_id.as_deref() == Some(&session),
                    "running_task_required",
                )?;
                (
                    task.work_id,
                    format!(
                        "{}:{}:{}:{}",
                        plan.id, plan.tree_version, task.id, task.revision
                    ),
                    task.description,
                )
            } else {
                (
                    format!("TURN:{turn}"),
                    turn.clone(),
                    "Direct admitted action".into(),
                )
            };
            Ok(WorkModelEffectGrant {
                scope_id,
                revision_id,
                session,
                turn,
                objective,
                repository,
                publication: None,
            })
        })
        .await
    }

    pub async fn effect_specs(&self, session: String) -> Result<Vec<SpecRef>> {
        self.lane(move |db| {
            let Some(plan) = reads::plan(db, &session)?.filter(|p| p.status != "completed") else {
                return Ok(vec![]);
            };
            let current: Option<String> = db
                .query_row(
                    "SELECT current_task_id FROM wm_sessions WHERE session_id=?1",
                    [&session],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            let task = tasks::load(
                db,
                &plan.scope_id,
                &plan.id,
                &current.ok_or_else(|| error("running_task_required"))?,
            )?;
            check(task.status == "running", "running_task_required")?;
            reads::ancestors(db, &session, &task.spec_ref.node_id)
        })
        .await
    }
}

fn apply(
    db: &Connection,
    session: &str,
    request: &WorkModelRequest,
    creation: Option<Creation>,
) -> Result<Value> {
    if let Some(creation) = creation {
        if matches!(request.command, WorkModelCommand::Publish { .. }) {
            return Ok(
                json!({"ok":true,"published_refs":creation.verified.iter().map(|s| &s.reference).collect::<Vec<_>>(),"active":false}),
            );
        }
        return creation::create(db, session, request, &creation);
    }
    let plan = reads::require_plan(db, session)?;
    check(
        request.expected_graph_revision == Some(plan.graph_revision),
        "graph_revision_conflict",
    )?;
    child::authorize(db, session, &plan, &request.command)?;
    match &request.command {
        WorkModelCommand::Reorder { .. }
        | WorkModelCommand::Dependencies { .. }
        | WorkModelCommand::Step { .. } => graph::apply(db, &plan.scope_id, &plan, request),
        WorkModelCommand::CompleteWork { .. } | WorkModelCommand::CompletePlan => {
            tasks::aggregate(db, &plan.scope_id, &plan, &request.command)
        }
        _ => tasks::apply(db, session, &plan, request),
    }
}

fn sql(source: rusqlite::Error) -> BtccError {
    error("work_model_storage_error").with_source(source)
}
fn encode(value: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string(value)
        .map_err(|source| error("work_model_encoding_failed").with_source(source))
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value)
        .map_err(|source| error("work_model_integrity_error").with_source(source))
}

pub(in crate::btcc::storage) fn contract_allowed(contract: Option<&str>) -> bool {
    contract == Some("split-v1")
        || (contract == Some("work-model-core-v1")
            && std::env::var("BUTLER_WORK_MODEL").as_deref() == Ok("core"))
}

// Spec bodies have one durable authority: immutable Ledger records. Intents and
// audit retain identity/hash/provenance, never a second editable body.
fn audit_request(request: &WorkModelRequest) -> Result<Value> {
    let mut value = serde_json::to_value(request)
        .map_err(|e| error("work_model_encoding_failed").with_source(e))?;
    match &request.command {
        WorkModelCommand::Create { bundle } => {
            *value
                .pointer_mut("/command/bundle/nodes")
                .ok_or_else(|| error("work_model_encoding_failed"))? =
                node_provenance(&bundle.nodes)?;
        }
        WorkModelCommand::Publish { nodes } => {
            *value
                .pointer_mut("/command/nodes")
                .ok_or_else(|| error("work_model_encoding_failed"))? = node_provenance(nodes)?;
        }
        WorkModelCommand::CreateLight { done_criteria, .. } => {
            *value
                .pointer_mut("/command/done_criteria")
                .ok_or_else(|| error("work_model_encoding_failed"))? = json!({"ids":done_criteria.iter().map(|c| &c.id).collect::<Vec<_>>(),"hash":fingerprint(done_criteria)?});
        }
        _ => {}
    }
    Ok(value)
}
fn node_provenance(nodes: &[SpecDraft]) -> Result<Value> {
    Ok(json!(nodes.iter().map(|n| Ok(json!({"node_id":n.node_id,"node_revision":n.node_revision,"content_hash":fingerprint(n)?}))).collect::<Result<Vec<_>>>()?))
}

fn set(value: &mut Value, key: &str, item: Value) -> Result<()> {
    value
        .as_object_mut()
        .ok_or_else(|| error("work_model_encoding_failed"))?
        .insert(key.into(), item);
    Ok(())
}
