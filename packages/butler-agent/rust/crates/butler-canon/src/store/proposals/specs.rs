//! Keyed spec authoring over the existing immutable publication/CAS functions.
use super::*;
pub fn project_nodes(db: &Connection, project: &str) -> Result<Value> {
    Ok(json!(rows(db, queries::PROJECT_SPECS, [project])?))
}
pub fn read(db: &Connection, id: &str) -> Result<Value> {
    let mut node = one(db, super::super::sql::NODE, [id])?;
    if node["scope_kind"] != "project" || node["visibility"] != "canon" {
        return Err(Error::NotFound);
    }
    node["body"] = Value::Null;
    if let Some(rev) = node["active_revision"].as_i64() {
        let publication = one(db, super::super::sql::SPEC_REVISION, params![id, rev])?;
        let compressed: Vec<u8> = db.query_row(
            "SELECT body FROM canon_spec_bodies WHERE hash=?1",
            [text(&publication, "body_hash")?],
            |r| r.get(0),
        )?;
        let body = zstd::stream::decode_all(compressed.as_slice()).map_err(Error::BodyCodec)?;
        node["body"] =
            json!(String::from_utf8(body).map_err(|_| Error::Invalid("spec body is not UTF-8"))?);
        node["criteria"] = json!(rows(
            db,
            super::super::api::sql::SPEC_CRITERIA,
            params![id, rev]
        )?);
    }
    Ok(node)
}
pub(super) fn edit(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    change: &Value,
) -> Result<Value> {
    let id = text(change, "id")?;
    let node = one(tx, super::super::sql::NODE, [id])?;
    if node["scope_kind"] != "project"
        || node["scope_ref"] != project
        || node["visibility"] != "canon"
    {
        return Err(Error::Invalid("spec outside project"));
    }
    let expected = change["expected_revision"]
        .as_i64()
        .ok_or(Error::Invalid("expected_revision required"))?;
    cas(&node, "revision", expected)?;
    publish(tx, ctx, &node, change, expected)?;
    Ok(json!({"op":"spec.edit","id":id,"revision":expected+2}))
}

pub(super) fn create(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    change: &Value,
) -> Result<Value> {
    let epic = text(change, "id")?;
    if read_work(tx, epic)?["project_id"] != project {
        return Err(Error::Invalid("spec outside project"));
    }
    let body = text(change, "body")?;
    let title = body
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("# "))
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .ok_or(Error::Invalid("spec body must start with '# ' and a title"))?;
    let id = crate::work_ids::IdGenerator::global_next(crate::work_ids::IdKind::Spec, ctx.now)?;
    let node = create_spec_node(
        tx,
        ctx,
        &NewSpecNode {
            id: id.clone(),
            scope_kind: crate::work_types::ScopeKind::Project,
            scope_ref: project.into(),
            epic_id: Some(epic.into()),
            parent_node_id: None,
            concern_id: title.into(),
        },
        &Registration::Canon(UserAct::new(
            ctx.actor["person"].as_str().unwrap_or_default(),
        )),
    )?;
    publish(tx, ctx, &node, change, 0)?;
    Ok(json!({"op":"spec.create","id":id,"epic_id":epic,"revision":2}))
}

fn publish(
    tx: &Transaction<'_>,
    ctx: &Context,
    node: &Value,
    change: &Value,
    expected: i64,
) -> Result<()> {
    let id = text(node, "node_id")?;
    let body = put_body(tx, text(change, "body")?)?;
    let next: i64 = tx.query_row(
        "SELECT COALESCE(MAX(revision),0)+1 FROM canon_spec_revisions WHERE node_id=?1",
        [id],
        |r| r.get(0),
    )?;
    let criteria = criteria(tx, node, change)?;
    publish_spec(
        tx,
        ctx,
        id,
        expected,
        &Publication {
            revision: next,
            body_hash: body,
            parser_version: "markdown".into(),
            criteria,
        },
    )?;
    activate_spec(
        tx,
        ctx,
        id,
        expected + 1,
        node["active_revision"].as_i64(),
        next,
    )?;
    Ok(())
}

fn criteria(db: &Connection, node: &Value, change: &Value) -> Result<Vec<Criterion>> {
    let items = if let Some(value) = change.get("criteria") {
        value
            .as_array()
            .cloned()
            .ok_or(Error::Invalid("criteria must be an array"))?
    } else if let Some(revision) = node["active_revision"].as_i64() {
        rows(
            db,
            super::super::api::sql::SPEC_CRITERIA,
            params![text(node, "node_id")?, revision],
        )?
    } else {
        Vec::new()
    };
    items
        .iter()
        .map(|c| {
            Ok(Criterion {
                id: c
                    .get("id")
                    .or_else(|| c.get("criterion_id"))
                    .and_then(Value::as_str)
                    .ok_or(Error::Invalid("criterion id required"))?
                    .into(),
                part_id: text(c, "part_id")?.into(),
                text: text(c, "text")?.into(),
            })
        })
        .collect()
}
