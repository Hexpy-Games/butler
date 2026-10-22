//! Transaction operations. The caller owns an IMMEDIATE transaction and must
//! roll it back on any error. No operation commits, opens a DB, or starts work.
pub mod api;
pub use api::{mark_outbox_published, read as read_api, write as write_api};
mod counts;
mod migration;
use counts::ensure_work_counts;
mod entities;
mod task_fields;
pub use task_fields::*;
mod task_placement;
pub use task_placement::*;
pub mod apply;
pub mod control;
pub mod execution;
pub use control::{
    Instruction as SessionInstruction, active_holds as active_session_holds,
    admit as admit_instruction, epoch as control_epoch, hold as hold_session,
    mark_applied as apply_instruction, mark_delivered as deliver_instruction,
    next_pending as pending_instructions, release as release_session_hold,
};
pub use execution::sql as execution_sql;
pub use execution::{
    ExecutionScope, Submission, assign_part, assign_task, block_task, fail_part, fail_task,
    report_task, start_task, submit_task, deliver_delegated_result, end_delegated_delivery,
};
pub use parts::{NewPart, add_part, read_part};
mod holds;
pub mod parts;
mod queue;
mod recovery;
mod specs;
pub mod sql;
pub mod tiers;
pub mod tool_ops;
pub mod tool_read;
mod transaction;
mod transitions;
pub use entities::*;
pub use holds::*;
use holds::{approval_covers, rederive_holds, task_result};
pub use queue::*;
use queue::{bump, persist, running, update_chain_state};
pub use recovery::*;
use rusqlite::{Connection, OptionalExtension, Params, Row};
use serde_json::{Value, json};
pub use specs::*;
pub use tool_read::bound_work;
pub use transaction::Transaction;
pub use transitions::*;
use transitions::{recompute_work, set_state};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Id(#[from] crate::work_ids::IdError),
    #[error("conflict: {current}")]
    Conflict { current: Value },
    #[error("not found")]
    NotFound,
    #[error("running")]
    Running,
    #[error("part cycle in Task {task}: {path:?}")]
    PartCycle { task: String, path: Vec<String> },
    #[error("invalid fractional rank")]
    InvalidRank,
    #[error("conversation already hosts a 과제")]
    ConversationOccupied,
    #[error("cross-chat chain move")]
    CrossChat,
    #[error("invalid operation: {0}")]
    Invalid(&'static str),
    #[error(transparent)]
    Chain(#[from] crate::work_chain::ChainError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("spec body codec: {0}")]
    BodyCodec(#[source] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone)]
pub struct Context {
    pub now: i64,
    pub actor: Value,
}
/// Constructed by a trusted UI/approval/MCP admission, never deserialized from
/// model arguments. Runtime creation accepts no visibility input.
#[derive(Debug, Clone)]
pub struct UserAct {
    person: String,
}
impl UserAct {
    pub fn new(person: impl Into<String>) -> Self {
        Self {
            person: person.into(),
        }
    }
    pub fn person(&self) -> &str {
        &self.person
    }
}
#[derive(Debug, Clone)]
pub enum Registration {
    Private,
    Canon(UserAct),
}

fn row_json(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut object = serde_json::Map::new();
    for (i, name) in row.as_ref().column_names().iter().enumerate() {
        let value = match row.get_ref(i)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(n) => json!(n),
            rusqlite::types::ValueRef::Real(n) => json!(n),
            rusqlite::types::ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
            rusqlite::types::ValueRef::Blob(_) => {
                return Err(rusqlite::Error::InvalidColumnType(
                    i,
                    (*name).into(),
                    rusqlite::types::Type::Blob,
                ));
            }
        };
        object.insert((*name).into(), value);
    }
    Ok(Value::Object(object))
}
pub(super) fn one(db: &Connection, statement: &str, params: impl Params) -> Result<Value> {
    db.query_row(statement, params, row_json)
        .optional()?
        .ok_or(Error::NotFound)
}
pub(super) fn rows(db: &Connection, statement: &str, params: impl Params) -> Result<Vec<Value>> {
    Ok(db
        .prepare(statement)?
        .query_map(params, row_json)?
        .collect::<rusqlite::Result<_>>()?)
}
pub(super) fn cas(row: &Value, field: &str, expected: i64) -> Result<()> {
    if row[field].as_i64() != Some(expected) {
        return Err(Error::Conflict {
            current: if field == "task_graph_revision" {
                json!({"task_graph_revision":row[field]})
            } else {
                row.clone()
            },
        });
    }
    Ok(())
}
pub(super) fn text<'a>(row: &'a Value, field: &str) -> Result<&'a str> {
    row[field]
        .as_str()
        .ok_or(Error::Invalid("missing text field"))
}
pub(super) fn event(
    tx: &Transaction<'_>,
    ctx: &Context,
    kind: &str,
    id: &str,
    revision: i64,
    op: &str,
) -> Result<()> {
    if let Some(effects) = tx.effects.borrow_mut().as_mut() {
        effects.events += 1;
        effects.changed = true;
        return Ok(());
    }
    let payload =
        json!({"entity_kind":kind,"entity_id":id,"revision":revision,"op":op}).to_string();
    tx.execute(
        sql::AUDIT,
        rusqlite::params![
            kind,
            id,
            revision,
            ctx.actor.to_string(),
            op,
            ctx.now,
            payload
        ],
    )?;
    api::outbox(tx, ctx, kind, id, revision, op)?;
    Ok(())
}
pub(crate) fn count(
    tx: &Transaction<'_>,
    scope: (&str, &str),
    key: &str,
    delta: i64,
) -> Result<()> {
    if let Some(effects) = tx.effects.borrow_mut().as_mut() {
        *effects
            .counts
            .entry((scope.0.into(), scope.1.into(), key.into()))
            .or_default() += delta;
        return Ok(());
    }
    tx.execute(sql::COUNT, rusqlite::params![scope.0, scope.1, key, delta])?;
    Ok(())
}
