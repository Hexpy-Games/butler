use super::*;
use crate::work_types::*;
use rusqlite::params;
use sha2::{Digest, Sha256};
#[derive(Debug, Clone)]
pub struct NewSpecNode {
    pub id: String,
    pub scope_kind: ScopeKind,
    pub scope_ref: String,
    pub epic_id: Option<String>,
    pub parent_node_id: Option<String>,
    pub concern_id: String,
}
pub fn create_spec_node(
    tx: &Transaction<'_>,
    ctx: &Context,
    node: &NewSpecNode,
    registration: &Registration,
) -> Result<Value> {
    let visibility = match registration {
        Registration::Canon(_) => "canon",
    };
    tx.execute(
        sql::INSERT_NODE,
        params![
            node.id,
            node.scope_kind.as_str(),
            node.scope_ref,
            node.epic_id,
            node.parent_node_id,
            node.concern_id,
            visibility,
            ctx.now,
            ctx.actor.to_string()
        ],
    )?;
    count(
        tx,
        (node.scope_kind.as_str(), &node.scope_ref),
        "spec_nodes",
        1,
    )?;
    event(tx, ctx, "spec_node", &node.id, 0, "create")?;
    one(tx, sql::NODE, [&node.id])
}
/// Hashes uncompressed UTF-8; stores zstd bytes compatible with the schema
/// fixture and future readers. An existing hash is a no-op.
pub fn put_body(tx: &Transaction<'_>, body: &str) -> Result<String> {
    let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    match one(tx, sql::BODY, [&hash]) {
        Ok(_) => return Ok(hash),
        Err(Error::NotFound) => {}
        Err(e) => return Err(e),
    }
    let compressed = zstd::stream::encode_all(body.as_bytes(), 3).map_err(Error::BodyCodec)?;
    tx.execute(sql::PUT_BODY, params![hash, compressed, body.len()])?;
    Ok(hash)
}
/// Criteria are supplied by the authoring layer as structured data. This store
/// derives immutable index rows during publication only; it does not parse MD.
#[derive(Debug, Clone)]
pub struct Criterion {
    pub id: String,
    pub part_id: String,
    pub text: String,
}
#[derive(Debug, Clone)]
pub struct Publication {
    pub revision: i64,
    pub body_hash: String,
    pub parser_version: String,
    pub criteria: Vec<Criterion>,
}
pub fn publish_spec(
    tx: &Transaction<'_>,
    ctx: &Context,
    node_id: &str,
    expected_revision: i64,
    publication: &Publication,
) -> Result<Value> {
    let node = one(tx, sql::NODE, [node_id])?;
    cas(&node, "revision", expected_revision)?;
    one(tx, sql::BODY, [&publication.body_hash])?;
    tx.execute(
        sql::PUBLISH,
        params![
            node_id,
            publication.revision,
            publication.body_hash,
            publication.parser_version
        ],
    )?;
    for criterion in &publication.criteria {
        tx.execute(
            sql::CRITERION,
            params![
                node_id,
                publication.revision,
                criterion.id,
                criterion.part_id,
                criterion.text
            ],
        )?;
    }
    criteria::reconcile(tx, node_id, publication.revision)?;
    tx.execute(sql::NODE_BUMP, params![node_id, ctx.now, expected_revision])?;
    event(
        tx,
        ctx,
        "spec_node",
        node_id,
        expected_revision + 1,
        "publish",
    )?;
    one(
        tx,
        sql::SPEC_REVISION,
        params![node_id, publication.revision],
    )
}
pub fn activate_spec(
    tx: &Transaction<'_>,
    ctx: &Context,
    node_id: &str,
    expected_revision: i64,
    expected_active_revision: Option<i64>,
    revision: i64,
) -> Result<Value> {
    let node = one(tx, sql::NODE, [node_id])?;
    cas(&node, "revision", expected_revision)?;
    if node["active_revision"] != json!(expected_active_revision) {
        return Err(Error::Conflict { current: node });
    }
    let publication = one(tx, sql::SPEC_REVISION, params![node_id, revision])?;
    if publication["state"] == "active" {
        return Ok(node);
    }
    if let Some(old) = expected_active_revision {
        tx.execute(sql::SPEC_STATE, params![node_id, old, "inactive"])?;
    }
    tx.execute(sql::SPEC_STATE, params![node_id, revision, "active"])?;
    tx.execute(
        sql::ACTIVATE,
        params![
            node_id,
            revision,
            ctx.now,
            expected_revision,
            expected_active_revision
        ],
    )?;
    event(
        tx,
        ctx,
        "spec_node",
        node_id,
        expected_revision + 1,
        "activate",
    )?;
    one(tx, sql::NODE, [node_id])
}
