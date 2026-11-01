//! Transaction operations. The caller owns an IMMEDIATE transaction and must
//! roll it back on any error. No operation commits, opens a DB, or starts work.
pub mod activity;
mod agents;
pub mod api;
mod attachments;
pub mod criteria;
pub mod grants;
pub use grants::sanitize as sanitize_mcp_client;
pub use public::{
    Activity as CanonActivity, Epic as CanonEpic, Page as CanonPage, SpecBody as CanonSpecBody,
};
pub mod mcp_proposals;
pub mod page;
pub mod proposals;
pub mod public;
pub use attachments::{
    references as attachment_references, references_lenient as attachment_references_lenient,
};
pub use proposals::queries::COUNT as COUNT_CANON_OPEN_PROPOSALS;
pub use proposals::specs::{project_nodes as canon_project_spec_nodes, read as read_canon_spec};
pub use proposals::view::{detail as canon_proposal_detail, open as open_canon_proposals};
pub use proposals::{
    APPLIED_MESSAGE as CANON_APPLIED_MESSAGE, apply as apply_canon_proposal,
    bind as bind_canon_proposal_epic, create as create_canon_proposal, get as get_canon_proposal,
    select_target as select_canon_proposal_target, transition as transition_canon_proposal,
    turn_cards as canon_proposal_turn_cards,
};
pub mod queue;
pub use queue::note as queue_note;
pub mod runtime;
pub use api::{mark_outbox_published, read as read_api, write as write_api};
pub use runtime::{
    context as session_epic_context, link as link_work, precheck as precheck_epic_link,
    runtime_context, steward_context,
};
mod entities;
mod intents;
mod specs;
pub mod sql;
mod transaction;
pub use entities::*;
pub use intents::*;
use rusqlite::{Connection, OptionalExtension, Params, Row};
use serde_json::{Value, json};
pub use specs::*;
pub use transaction::Transaction;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Id(#[from] crate::work_ids::IdError),
    #[error("{}", conflict_message(.current))]
    Conflict { current: Value },
    #[error("tag already exists")]
    TagExists { existing: Value },
    #[error("epic is running")]
    Running,
    #[error("permission denied")]
    Permission,
    #[error("not found")]
    NotFound,
    #[error("invalid fractional rank")]
    InvalidRank,
    #[error("expected_revision required: pass the revision from the latest plan run note.")]
    QueueRevisionRequired,
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
            current: row.clone(),
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
    event_with_details(tx, ctx, (kind, id, revision, op), &json!({}))
}
fn event_with_details(
    tx: &Transaction<'_>,
    ctx: &Context,
    (kind, id, revision, op): (&str, &str, i64, &str),
    details: &Value,
) -> Result<()> {
    let mut payload = json!({"entity_kind":kind,"entity_id":id,"revision":revision,"op":op});
    if let (Some(payload), Some(details)) = (payload.as_object_mut(), details.as_object()) {
        payload.extend(details.clone());
    }
    tx.execute(
        sql::AUDIT,
        rusqlite::params![
            kind,
            id,
            revision,
            ctx.actor.to_string(),
            op,
            ctx.now,
            payload.to_string()
        ],
    )?;
    api::outbox(tx, ctx, kind, id, revision, details)?;
    Ok(())
}
pub(super) fn count(
    tx: &Transaction<'_>,
    scope: (&str, &str),
    key: &str,
    delta: i64,
) -> Result<()> {
    tx.execute(sql::COUNT, rusqlite::params![scope.0, scope.1, key, delta])?;
    Ok(())
}

fn conflict_message(current: &Value) -> String {
    if let (Some(expected), Some(current)) = (
        current["expected_revision"].as_i64(),
        current["graph_revision"].as_i64(),
    ) {
        format!(
            "The run changed since revision {expected}; it is now at revision {current}. Read the order in the latest plan run note and send the change again with that revision."
        )
    } else {
        format!("conflict: {current}")
    }
}
