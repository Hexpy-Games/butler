//! Op generation at write time, in five phases: resolve, diff, guard,
//! validate, commit. A refused write leaves nothing behind.
use super::*;
use crate::work_ids::{IdGenerator, IdKind};
use serde_json::Map;
use std::collections::BTreeSet;

pub(super) struct Spec {
    pub(super) sync: &'static str,
    pub(super) table: &'static str,
    pub(super) read: &'static str,
    pub(super) set: &'static [&'static str],
    pub(super) moves: &'static [&'static str],
}
pub(super) static PLAN: Spec = Spec {
    sync: "plan",
    table: "canon_plans",
    read: crate::store::sql::PLAN,
    set: &["title", "description", "status", "due_on"],
    moves: &[],
};
pub(super) static EPIC: Spec = Spec {
    sync: "epic",
    table: "canon_epics",
    read: crate::store::sql::WORK,
    set: &["title", "description", "canon_status", "assignee"],
    moves: &["plan_id", "plan_rank"],
};
pub(super) static TAG: Spec = Spec {
    sync: "tag",
    table: "canon_tags",
    read: api::sql::TAG,
    set: &["name", "color"],
    moves: &[],
};
/// Local event kinds (`work`) and synced kinds (`epic`) name the same spec.
pub(super) fn spec(kind: &str) -> Option<&'static Spec> {
    match kind {
        "plan" => Some(&PLAN),
        "work" | "epic" => Some(&EPIC),
        "tag" => Some(&TAG),
        _ => None,
    }
}

/// The synced columns of a local row, as they are sent and stored.
pub(super) fn data(spec: &Spec, row: &Value) -> Map<String, Value> {
    spec.set
        .iter()
        .chain(spec.moves)
        .map(|&field| {
            let value = match (field, &row[field]) {
                ("assignee", Value::String(s)) if s.is_empty() => Value::Null,
                ("canon_status", Value::Null) => json!("planned"),
                ("due_on", Value::String(s)) if !day(s) => Value::Null,
                (_, value) => value.clone(),
            };
            (field.to_owned(), value)
        })
        .collect()
}
fn day(value: &str) -> bool {
    value.len() == 10
        && value.bytes().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}
/// Server limits, counted in UTF-16 units as the server's JavaScript counts.
fn fits(field: &str, value: &Value) -> Result<()> {
    let range = match field {
        "title" => 1..=500,
        "description" => 0..=20_000,
        "assignee" => 1..=200,
        "name" | "plan_rank" => 1..=64,
        "body" => 1..=20_000,
        _ => return Ok(()),
    };
    match value.as_str() {
        Some(text) if !range.contains(&text.encode_utf16().count()) => Err(Error::Fields(format!(
            "{field} is too long for an online project"
        ))),
        _ => Ok(()),
    }
}

struct PlannedOp {
    entity_id: String,
    kind: &'static str,
    action: &'static str,
    fields: Map<String, Value>,
}
enum Copy {
    Put {
        entity_id: String,
        kind: &'static str,
        local_key: String,
        parent: Option<String>,
        data: Map<String, Value>,
    },
    SetData {
        entity_id: String,
        data: Map<String, Value>,
    },
    Delete {
        entity_id: String,
        children: bool,
    },
}
#[derive(Default)]
struct Planned {
    ops: Vec<PlannedOp>,
    copies: Vec<Copy>,
}
impl Planned {
    fn op(
        &mut self,
        entity_id: &str,
        kind: &'static str,
        action: &'static str,
        fields: Map<String, Value>,
    ) {
        self.ops.push(PlannedOp {
            entity_id: entity_id.to_owned(),
            kind,
            action,
            fields,
        });
    }
}

pub(in crate::store) fn capture(
    tx: &Transaction<'_>,
    ctx: &Context,
    kind: &str,
    id: &str,
    op: &str,
) -> Result<()> {
    if ctx.actor["via"] == "sync" {
        return Ok(());
    }
    let Some(spec) = spec(kind) else {
        return Ok(());
    };
    let row = one(tx, spec.read, [id])?;
    let project = text(&row, "project_id")?;
    let Some(link) = link_by_project(tx, project)? else {
        return Ok(());
    };
    let planned = if op == "delete" {
        delete_ops(tx, spec, id, project)?
    } else {
        change_ops(tx, ctx, spec, &row, project)?
    };
    commit(tx, ctx, &link, planned)
}
pub(in crate::store) fn capture_comment(
    tx: &Transaction<'_>,
    ctx: &Context,
    epic_id: &str,
    seq: i64,
    body: &str,
) -> Result<()> {
    if ctx.actor["via"] == "sync" {
        return Ok(());
    }
    let epic = read_work(tx, epic_id)?;
    let Some(link) = link_by_project(tx, text(&epic, "project_id")?)? else {
        return Ok(());
    };
    let id = IdGenerator::global_next(IdKind::Comment, ctx.now)?;
    let data = pair("body", epic_id, body);
    let mut planned = Planned::default();
    planned.op(&id, "comment", "append", data.clone());
    planned.copies.push(Copy::Put {
        entity_id: id,
        kind: "comment",
        local_key: seq.to_string(),
        parent: Some(epic_id.to_owned()),
        data,
    });
    commit(tx, ctx, &link, planned)
}
pub(super) fn pair(field: &str, epic_id: &str, value: &str) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("epic_id".into(), json!(epic_id));
    data.insert(field.into(), json!(value));
    data
}

fn change_ops(
    tx: &Transaction<'_>,
    ctx: &Context,
    spec: &Spec,
    row: &Value,
    project: &str,
) -> Result<Planned> {
    let id = text(row, "id")?;
    let now = data(spec, row);
    let mut planned = Planned::default();
    match find(tx, sql::ENTITY_BY_KEY, params![spec.sync, id, project])? {
        None => {
            planned.op(id, spec.sync, "create", now.clone());
            planned.copies.push(Copy::Put {
                entity_id: id.to_owned(),
                kind: spec.sync,
                local_key: id.to_owned(),
                parent: None,
                data: now,
            });
        }
        Some(copy) => {
            let old = object(text(&copy, "data_json")?)?;
            let changed = |field: &&str| now.get(*field) != old.get(*field);
            let pick = |fields: &[&str]| -> Map<String, Value> {
                fields
                    .iter()
                    .map(|&f| (f.to_owned(), now[f].clone()))
                    .collect()
            };
            if spec.moves.iter().any(changed) {
                planned.op(id, spec.sync, "move", pick(spec.moves));
            }
            let set: Vec<&str> = spec.set.iter().copied().filter(changed).collect();
            if !set.is_empty() {
                planned.op(id, spec.sync, "set", pick(&set));
            }
            if !planned.ops.is_empty() {
                planned.copies.push(Copy::SetData {
                    entity_id: id.to_owned(),
                    data: now,
                });
            }
        }
    }
    if spec.sync == EPIC.sync {
        tag_ops(tx, ctx, id, project, &mut planned)?;
    }
    Ok(planned)
}
/// Local tag links against live `epic_tag` copies; one local pair may have
/// several live entities (two devices tagged at once).
fn tag_ops(
    tx: &Transaction<'_>,
    ctx: &Context,
    epic: &str,
    project: &str,
    planned: &mut Planned,
) -> Result<()> {
    let local = rows(tx, sql::EPIC_TAG_IDS, [epic])?
        .iter()
        .map(|row| text(row, "tag_id").map(str::to_owned))
        .collect::<Result<BTreeSet<_>>>()?;
    let mut synced = Vec::new();
    for copy in rows(tx, sql::EPIC_TAG_ENTITIES, params![epic, project])? {
        let data = object(text(&copy, "data_json")?)?;
        let tag = data["tag_id"].as_str().unwrap_or_default().to_owned();
        synced.push((text(&copy, "entity_id")?.to_owned(), tag));
    }
    for tag in &local {
        if !synced.iter().any(|(_, synced)| synced == tag) {
            let id = IdGenerator::global_next(IdKind::EpicTag, ctx.now)?;
            let data = pair("tag_id", epic, tag);
            planned.op(&id, "epic_tag", "create", data.clone());
            planned.copies.push(Copy::Put {
                entity_id: id.clone(),
                kind: "epic_tag",
                local_key: id,
                parent: Some(epic.to_owned()),
                data,
            });
        }
    }
    for (entity, tag) in synced {
        if !local.contains(&tag) {
            planned.op(&entity, "epic_tag", "delete", Map::new());
            planned.copies.push(Copy::Delete {
                entity_id: entity,
                children: false,
            });
        }
    }
    Ok(())
}
/// The row still exists at the delete event; a never-synced entity sends nothing.
fn delete_ops(tx: &Transaction<'_>, spec: &Spec, id: &str, project: &str) -> Result<Planned> {
    let mut planned = Planned::default();
    if find(tx, sql::ENTITY_BY_KEY, params![spec.sync, id, project])?.is_some() {
        planned.op(id, spec.sync, "delete", Map::new());
        planned.copies.push(Copy::Delete {
            entity_id: id.to_owned(),
            children: spec.sync == EPIC.sync,
        });
    }
    Ok(planned)
}

/// Guard, validate, then commit the ops and copies.
fn commit(tx: &Transaction<'_>, ctx: &Context, link: &Value, planned: Planned) -> Result<()> {
    if planned.ops.is_empty() {
        return Ok(());
    }
    let detached = link["state"] == "detached";
    if detached || link["role"] == "viewer" {
        if ctx.actor["via"] == "butler" {
            return Ok(());
        }
        return Err(if detached {
            Error::Invalid("This project is disconnected from its online space.")
        } else {
            Error::Permission
        });
    }
    for op in &planned.ops {
        for (field, value) in &op.fields {
            fits(field, value)?;
        }
        let sized = json!({"op_id":"0".repeat(26),"entity_id":op.entity_id,"kind":op.kind,
            "action":op.action,"base_revision":0,"fields":op.fields});
        if serde_json::to_vec(&sized)?.len() > 60_000 {
            return Err(Error::Fields(
                "change is too large for an online project".into(),
            ));
        }
    }
    let (space, project) = (text(link, "space_id")?, text(link, "project_id")?);
    for op in &planned.ops {
        tx.execute(
            sql::OUTBOX_INSERT,
            params![
                IdGenerator::global_next(IdKind::Op, ctx.now)?,
                space,
                op.entity_id,
                op.kind,
                op.action,
                Value::Object(op.fields.clone()).to_string(),
                ctx.now
            ],
        )?;
    }
    for copy in planned.copies {
        match copy {
            Copy::Put {
                entity_id,
                kind,
                local_key,
                parent,
                data,
            } => tx.execute(
                sql::PUT_ENTITY,
                params![
                    entity_id,
                    project,
                    kind,
                    local_key,
                    parent,
                    0,
                    Value::Object(data).to_string()
                ],
            )?,
            Copy::SetData { entity_id, data } => tx.execute(
                sql::SET_ENTITY_DATA,
                params![entity_id, Value::Object(data).to_string(), project],
            )?,
            Copy::Delete {
                entity_id,
                children,
            } => {
                tx.execute(sql::DELETE_ENTITY, params![entity_id, project])?;
                if children {
                    tx.execute(sql::DELETE_CHILD_ENTITIES, params![entity_id, project])?;
                }
                0
            }
        };
    }
    Ok(())
}
