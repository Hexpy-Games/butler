//! Remote apply: stream records, rejects, snapshot replace and queue replay.
//! Every copy lookup is scoped by the link's project and every outbox lookup
//! by its space.
mod write;
use super::*;
use capture::{EPIC, PLAN, Spec, TAG, data, pair, spec};
use serde_json::Map;
use write::*;

pub(super) fn records(
    tx: &Transaction<'_>,
    space: &str,
    records: &[Value],
    members: &Map<String, Value>,
    now: i64,
) -> Result<Applied> {
    let Some(link) = link_by_space(tx, space)? else {
        return Ok(Applied {
            missing: true,
            ..Applied::default()
        });
    };
    let project = text(&link, "project_id")?;
    let start = number(&link, "cursor_seq")?;
    let mut applied = Applied {
        cursor: start,
        ..Applied::default()
    };
    for record in records {
        let seq = number(record, "seq")?;
        if seq <= applied.cursor {
            continue;
        }
        if seq != applied.cursor + 1 {
            applied.gap = true;
            break;
        }
        let (op_id, entity) = (text(record, "op_id")?, text(record, "entity_id")?);
        let revision = number(record, "revision")?;
        if find(tx, sql::OUTBOX_OP, params![op_id, space])?.is_some() {
            tx.execute(sql::RAISE_SYNC_REVISION, params![entity, revision, project])?;
            tx.execute(sql::OUTBOX_DELETE, [op_id])?;
        } else if find(tx, sql::ENTITY, params![entity, project])?
            .is_none_or(|copy| copy["sync_revision"].as_i64() < Some(revision))
        {
            let ctx = remote(record, members, now);
            if !savepoint(tx, "sync_op", || one_op(tx, &ctx, (project, space), record))? {
                applied.skipped.push(op_id.to_owned());
            }
        }
        applied.cursor = seq;
    }
    if applied.cursor != start {
        tx.execute(sql::SET_CURSOR, params![space, applied.cursor])?;
    }
    Ok(applied)
}
fn remote(record: &Value, members: &Map<String, Value>, now: i64) -> Context {
    let account = &record["account_id"];
    let person = account
        .as_str()
        .and_then(|id| members.get(id))
        .unwrap_or(account);
    Context {
        now,
        actor: json!({"person":person,"via":"sync","account":account,"device":record["device_id"]}),
    }
}
fn fields(value: &Value) -> Result<&Map<String, Value>> {
    value
        .as_object()
        .ok_or(Error::Invalid("fields must be an object"))
}

fn one_op(
    tx: &Transaction<'_>,
    ctx: &Context,
    (project, space): (&str, &str),
    r: &Value,
) -> Result<()> {
    let (kind, action) = (text(r, "kind")?, text(r, "action")?);
    let item = Item {
        id: text(r, "entity_id")?,
        fields: fields(&r["fields"])?,
        revision: number(r, "revision")?,
    };
    if matches!(action, "create" | "append") {
        owned(tx, item.id, project)?;
    }
    match (kind, action) {
        ("plan" | "epic" | "tag", "set" | "move" | "create") => {
            let spec = spec(kind).ok_or(Error::Invalid("kind"))?;
            if local(tx, spec, item.id, project)?.is_some() {
                set(tx, ctx, (project, space), spec, &item)
            } else if action == "create" {
                add(tx, ctx, (spec, project), &item, false)
            } else {
                Ok(())
            }
        }
        (_, "delete") => {
            tx.execute(sql::OUTBOX_DELETE_ENTITY, params![item.id, space])?;
            remove(tx, ctx, project, (kind, item.id), &Value::Null, false)
        }
        ("epic_tag", "create") => tag_link(tx, ctx, project, &item, false),
        ("comment", "append") => comment(tx, ctx, project, &item),
        _ => Err(Error::Invalid("unknown sync op")),
    }
}
/// A remote set or move on an existing row. Unsent local values for the
/// same fields lose and are recorded as a conflict; sent rows stay frozen.
fn set(
    tx: &Transaction<'_>,
    ctx: &Context,
    (project, space): (&str, &str),
    spec: &Spec,
    item: &Item<'_>,
) -> Result<()> {
    let fields = resolve(tx, project, spec, item.fields)?;
    let mut removed = Map::new();
    for row in rows(tx, sql::OUTBOX_ENTITY, params![item.id, space])? {
        if !row["base_revision"].is_null() {
            continue;
        }
        let op_id = text(&row, "op_id")?;
        let mut queued = object(text(&row, "fields_json")?)?;
        match text(&row, "action")? {
            "set" => {
                let before = queued.len();
                for name in fields.keys() {
                    if let Some(value) = queued.remove(name) {
                        removed.insert(name.clone(), value);
                    }
                }
                if queued.is_empty() {
                    tx.execute(sql::OUTBOX_DELETE, [op_id])?;
                } else if queued.len() != before {
                    let queued = Value::Object(queued).to_string();
                    tx.execute(sql::OUTBOX_SET_FIELDS, params![op_id, queued])?;
                }
            }
            "move" if fields.contains_key("plan_id") || fields.contains_key("plan_rank") => {
                removed.extend(queued);
                tx.execute(sql::OUTBOX_DELETE, [op_id])?;
            }
            _ => {}
        }
    }
    if !removed.is_empty() {
        conflict(tx, ctx, spec, item.id, &removed)?;
    }
    write_fields(tx, ctx, (spec, project), item.id, &fields, false)?;
    let mut copy = match find(tx, sql::ENTITY, params![item.id, project])? {
        Some(copy) => object(text(&copy, "data_json")?)?,
        None => data(spec, &one(tx, spec.read, [item.id])?),
    };
    copy.extend(fields);
    put(
        tx,
        project,
        (spec.sync, item.id, item.id, None),
        item.revision,
        &copy,
    )
}
/// Creates a missing plan, epic or tag and stores its copy at `revision`.
fn add(
    tx: &Transaction<'_>,
    ctx: &Context,
    (spec, project): (&Spec, &str),
    item: &Item<'_>,
    quiet: bool,
) -> Result<()> {
    let fields = resolve(tx, project, spec, item.fields)?;
    insert(tx, ctx, (spec, project), item.id, &fields, quiet)?;
    let copy = data(spec, &one(tx, spec.read, [item.id])?);
    put(
        tx,
        project,
        (spec.sync, item.id, item.id, None),
        item.revision,
        &copy,
    )
}
/// Deletes locally and drops the copy (and an epic's child copies). An
/// epic_tag resolves its pair through the copy, else through `fallback`.
fn remove(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    (kind, id): (&str, &str),
    fallback: &Value,
    quiet: bool,
) -> Result<()> {
    if kind == "epic_tag" {
        let pair = match find(tx, sql::ENTITY, params![id, project])? {
            Some(copy) => Some(object(text(&copy, "data_json")?)?),
            None => fallback.as_object().cloned(),
        };
        tx.execute(sql::DELETE_ENTITY, params![id, project])?;
        return match pair {
            Some(pair) => unlink_pair(tx, ctx, project, &pair, quiet),
            None => Ok(()),
        };
    }
    delete_local(tx, ctx, project, kind, id)?;
    tx.execute(sql::DELETE_ENTITY, params![id, project])?;
    if kind == EPIC.sync {
        tx.execute(sql::DELETE_CHILD_ENTITIES, params![id, project])?;
    }
    Ok(())
}

/// The server rejected one of our ops; `current` is its entity or null.
pub(super) fn reject(
    tx: &Transaction<'_>,
    me: &Context,
    project: &str,
    space: &str,
    row: &Value,
    current: &Value,
) -> Result<()> {
    let (kind, action) = (text(row, "kind")?, text(row, "action")?);
    let entity = text(row, "entity_id")?;
    let live = current.is_object() && current["deleted"] != true;
    match action {
        "create" | "append" if live => {
            let revision = number(current, "revision")?;
            tx.execute(sql::RAISE_SYNC_REVISION, params![entity, revision, project])?;
            tx.execute(sql::OUTBOX_DELETE, [text(row, "op_id")?])?;
            Ok(())
        }
        "set" | "move" if live => {
            let spec = spec(kind).ok_or(Error::Invalid("kind"))?;
            let (mut lost, mut deleted) = (Map::new(), false);
            for later in rows(tx, sql::OUTBOX_ENTITY, params![entity, space])? {
                match text(&later, "action")? {
                    "delete" => {
                        deleted = true;
                        continue;
                    }
                    "set" | "move" => lost.extend(object(text(&later, "fields_json")?)?),
                    _ => {}
                }
                tx.execute(sql::OUTBOX_DELETE, [text(&later, "op_id")?])?;
            }
            if deleted {
                return Ok(());
            }
            replace(tx, me, project, current, true)?;
            if lost.is_empty() {
                Ok(())
            } else {
                conflict(tx, me, spec, entity, &lost)
            }
        }
        _ => {
            tx.execute(sql::OUTBOX_DELETE_ENTITY, params![entity, space])?;
            remove(tx, me, project, (kind, entity), &current["data"], true)
        }
    }
}

/// Makes local state match one server entity; events still fire when quiet.
fn replace(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    entity: &Value,
    quiet: bool,
) -> Result<()> {
    let (kind, id) = (text(entity, "kind")?, text(entity, "entity_id")?);
    let item = Item {
        id,
        fields: fields(&entity["data"])?,
        revision: number(entity, "revision")?,
    };
    if entity["deleted"] == true {
        return remove(tx, ctx, project, (kind, id), &Value::Null, quiet);
    }
    owned(tx, id, project)?;
    match (spec(kind), kind) {
        (Some(spec), "plan" | "epic" | "tag") => match local(tx, spec, id, project)? {
            Some(row) => {
                // Only the keys that differ; an unchanged entity writes nothing locally.
                let current = data(spec, &row);
                let fields: Map<String, Value> = resolve(tx, project, spec, item.fields)?
                    .into_iter()
                    .filter(|(name, value)| current.get(name) != Some(value))
                    .collect();
                if !fields.is_empty() {
                    write_fields(tx, ctx, (spec, project), id, &fields, quiet)?;
                }
                let copy = data(spec, &one(tx, spec.read, [id])?);
                put(tx, project, (kind, id, id, None), item.revision, &copy)?;
            }
            None => add(tx, ctx, (spec, project), &item, quiet)?,
        },
        (_, "epic_tag") => tag_link(tx, ctx, project, &item, quiet)?,
        (_, "comment") => {
            // The snapshot has no authors.
            let author = Context {
                now: ctx.now,
                actor: json!({"via":"sync"}),
            };
            comment(tx, &author, project, &item)?;
        }
        _ => return Err(Error::Invalid("unknown sync kind")),
    }
    tx.execute(
        sql::RAISE_SYNC_REVISION,
        params![id, item.revision, project],
    )?;
    Ok(())
}

/// Join and resync: the snapshot parents first, then every unacked op of the
/// space replayed on local state. Returns the skipped entity and op ids.
pub(super) fn replace_all(
    tx: &Transaction<'_>,
    me: &Context,
    project: &str,
    space: &str,
    snapshot: &Value,
) -> Result<Vec<String>> {
    const ORDER: [&str; 5] = ["plan", "tag", "epic", "epic_tag", "comment"];
    let mut entities: Vec<&Value> = snapshot["entities"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    entities.sort_by_key(|e| {
        let kind = ORDER.iter().position(|kind| e["kind"] == *kind);
        (kind, e["entity_id"].as_str().unwrap_or_default().to_owned())
    });
    let mut skipped = Vec::new();
    for entity in entities {
        if !savepoint(tx, "sync_replace", || {
            replace(tx, me, project, entity, true)
        })? {
            skipped.push(entity["entity_id"].as_str().unwrap_or_default().to_owned());
        }
    }
    for row in rows(tx, sql::OUTBOX_QUEUE, params![space, i64::MAX])? {
        if !savepoint(tx, "sync_replay", || replay(tx, me, project, &row))? {
            skipped.push(text(&row, "op_id")?.to_owned());
        }
    }
    Ok(skipped)
}
/// Re-applies one pending op to local state only; the queue and the copy's
/// `sync_revision` stay as they are.
fn replay(tx: &Transaction<'_>, me: &Context, project: &str, row: &Value) -> Result<()> {
    let (kind, action, id) = (
        text(row, "kind")?,
        text(row, "action")?,
        text(row, "entity_id")?,
    );
    let queued = object(text(row, "fields_json")?)?;
    let copy = find(tx, sql::ENTITY, params![id, project])?;
    let item = Item {
        id,
        fields: &queued,
        revision: copy
            .as_ref()
            .map_or(Ok(0), |copy| number(copy, "sync_revision"))?,
    };
    match (spec(kind), action) {
        (Some(spec), "set" | "move") if local(tx, spec, id, project)?.is_some() => {
            let fields = resolve(tx, project, spec, &queued)?;
            write_fields(tx, me, (spec, project), id, &fields, true)?;
            if let Some(copy) = copy {
                let mut data = object(text(&copy, "data_json")?)?;
                data.extend(fields);
                let data = Value::Object(data).to_string();
                tx.execute(sql::SET_ENTITY_DATA, params![id, data, project])?;
            }
            Ok(())
        }
        (_, "delete") => remove(tx, me, project, (kind, id), &Value::Null, true),
        (Some(spec), "create") if local(tx, spec, id, project)?.is_none() => {
            add(tx, me, (spec, project), &item, true)
        }
        (None, "create") => tag_link(tx, me, project, &item, true),
        (None, "append") => comment(tx, me, project, &item),
        _ => Ok(()),
    }
}
