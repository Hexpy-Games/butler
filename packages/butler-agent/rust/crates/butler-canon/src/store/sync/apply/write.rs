//! Local writes for remote changes. Every lookup is scoped to the link's project.
use super::*;
use rusqlite::types::Value as Sql;

/// One remote entity state: an op's fields or a snapshot entity's data.
pub(super) struct Item<'a> {
    pub(super) id: &'a str,
    pub(super) fields: &'a Map<String, Value>,
    pub(super) revision: i64,
}

fn sql_value(value: &Value) -> Sql {
    match value {
        Value::String(text) => Sql::Text(text.clone()),
        _ => Sql::Null,
    }
}
fn field(fields: &Map<String, Value>, name: &str) -> Sql {
    fields.get(name).map_or(Sql::Null, sql_value)
}
fn foreign() -> Error {
    Error::Invalid("entity belongs to another project")
}

/// The local row, if it exists; a row of another project refuses the op.
pub(super) fn local(
    tx: &Transaction<'_>,
    spec: &Spec,
    id: &str,
    project: &str,
) -> Result<Option<Value>> {
    match find(tx, spec.read, [id])? {
        Some(row) if row["project_id"] != project => Err(foreign()),
        row => Ok(row),
    }
}
/// A stored copy is never overwritten across projects.
pub(super) fn owned(tx: &Transaction<'_>, id: &str, project: &str) -> Result<()> {
    match find(tx, sql::ENTITY_OWNER, [id])? {
        Some(row) if row["project_id"] != project => Err(foreign()),
        _ => Ok(()),
    }
}
/// The spec's columns only; a `plan_id` missing locally becomes NULL.
pub(super) fn resolve(
    tx: &Transaction<'_>,
    project: &str,
    spec: &Spec,
    fields: &Map<String, Value>,
) -> Result<Map<String, Value>> {
    let mut resolved = Map::new();
    for (name, value) in fields {
        if !spec.set.contains(&name.as_str()) && !spec.moves.contains(&name.as_str()) {
            continue;
        }
        let value = match (name.as_str(), value.as_str()) {
            ("plan_id", Some(plan)) if local(tx, &PLAN, plan, project)?.is_none() => Value::Null,
            _ => value.clone(),
        };
        resolved.insert(name.clone(), value);
    }
    Ok(resolved)
}
pub(super) fn put(
    tx: &Transaction<'_>,
    project: &str,
    (kind, id, key, parent): (&str, &str, &str, Option<&str>),
    revision: i64,
    data: &Map<String, Value>,
) -> Result<()> {
    tx.execute(
        sql::PUT_ENTITY,
        params![
            id,
            project,
            kind,
            key,
            parent,
            revision,
            Value::Object(data.clone()).to_string()
        ],
    )?;
    Ok(())
}

/// One UPDATE over whitelisted columns, then the events and activity a local
/// write of the same fields produces (`quiet` skips the activity only).
pub(super) fn write_fields(
    tx: &Transaction<'_>,
    ctx: &Context,
    (spec, project): (&Spec, &str),
    id: &str,
    fields: &Map<String, Value>,
    quiet: bool,
) -> Result<()> {
    let old = one(tx, spec.read, [id])?;
    // A remote done/cancelled never ends a locally running epic, as local writes cannot.
    if spec.sync == EPIC.sync
        && fields
            .get("canon_status")
            .is_some_and(|status| status == "done" || status == "cancelled")
        && runtime::epic_running(tx, id)?
    {
        return Err(Error::Running);
    }
    let (mut columns, mut values) = (Vec::new(), Vec::new());
    for (name, value) in fields {
        values.push(sql_value(value));
        columns.push(format!("{name}=?{}", values.len()));
        if spec.sync == TAG.sync && name == "name" {
            values.push(Sql::Text(api::tags::name_key(
                value.as_str().unwrap_or_default(),
            )));
            columns.push(format!("name_key=?{}", values.len()));
        }
        if spec.sync == EPIC.sync && name == "canon_status" {
            columns.push("canon_status_source='person'".into());
        }
    }
    if columns.is_empty() {
        return Ok(());
    }
    values.extend([Sql::Integer(ctx.now), Sql::Text(id.to_owned())]);
    tx.execute(
        &format!(
            "UPDATE {} SET {},revision=revision+1,updated_at=?{} WHERE id=?{}",
            spec.table,
            columns.join(","),
            values.len() - 1,
            values.len()
        ),
        rusqlite::params_from_iter(values),
    )?;
    let revision = number(&old, "revision")? + 1;
    if spec.sync != EPIC.sync {
        return event(tx, ctx, spec.sync, id, revision, "edit");
    }
    let new = read_work(tx, id)?;
    if fields.keys().any(|name| EPIC.set.contains(&name.as_str())) {
        event(tx, ctx, "work", id, revision, "edit")?;
        let status = |row: &Value| row["canon_status"].as_str().unwrap_or("planned").to_owned();
        if !quiet && status(&old) != status(&new) {
            activity::status(tx, ctx, id, &status(&old), &status(&new))?;
        }
        if !quiet
            && ["title", "description", "assignee"]
                .iter()
                .any(|f| old[f] != new[f])
        {
            activity::append(tx, ctx, id, "edited", text(&new, "title")?, None)?;
        }
    }
    if fields
        .keys()
        .any(|name| EPIC.moves.contains(&name.as_str()))
    {
        event(tx, ctx, "work", id, revision, "reorder")?;
        let (from, to) = (old["plan_id"].as_str(), new["plan_id"].as_str());
        if from != to {
            api::bump_order(tx, ctx, from, project)?;
        }
        api::bump_order(tx, ctx, to, project)?;
        if !quiet && from != to {
            let plan = to.map(|plan| read_plan(tx, plan)).transpose()?;
            let title = plan.as_ref().map(|p| text(p, "title")).transpose()?;
            activity::append(tx, ctx, id, "moved", title.unwrap_or(""), None)?;
        }
    }
    Ok(())
}

/// The create branch for plans, epics and tags (fields already resolved).
pub(super) fn insert(
    tx: &Transaction<'_>,
    ctx: &Context,
    (spec, project): (&Spec, &str),
    id: &str,
    fields: &Map<String, Value>,
    quiet: bool,
) -> Result<()> {
    let actor = ctx.actor.to_string();
    let f = |name| field(fields, name);
    match spec.sync {
        "plan" => {
            tx.execute(
                crate::store::sql::INSERT_PLAN,
                params![
                    id,
                    project,
                    f("title"),
                    f("description"),
                    f("due_on"),
                    f("status"),
                    ctx.now,
                    actor
                ],
            )?;
            count(tx, ("project", project), "plans", 1)?;
            event(tx, ctx, "plan", id, 0, "create")
        }
        "tag" => {
            let name = fields
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            tx.execute(
                api::sql::INSERT_TAG,
                params![
                    id,
                    project,
                    name,
                    api::tags::name_key(name),
                    f("color"),
                    ctx.now,
                    actor
                ],
            )?;
            event(tx, ctx, "tag", id, 0, "create")
        }
        _ => {
            tx.execute(
                sql::INSERT_EPIC,
                params![
                    id,
                    project,
                    f("plan_id"),
                    f("title"),
                    f("description"),
                    f("canon_status"),
                    f("assignee"),
                    f("plan_rank"),
                    ctx.now,
                    actor
                ],
            )?;
            count(tx, ("project", project), "epics", 1)?;
            event_with_details(tx, ctx, ("work", id, 0, "create"), &json!({}))?;
            let row = read_work(tx, id)?;
            if !quiet {
                activity::append(tx, ctx, id, "created", text(&row, "title")?, None)?;
            }
            api::bump_order(tx, ctx, row["plan_id"].as_str(), project)
        }
    }
}

/// Removes a local entity; a missing row or copy is a no-op.
pub(super) fn delete_local(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    kind: &str,
    id: &str,
) -> Result<()> {
    match kind {
        "comment" => {
            let Some(copy) = find(tx, sql::ENTITY, params![id, project])? else {
                return Ok(());
            };
            let seq: i64 = text(&copy, "local_key")?
                .parse()
                .map_err(|_| Error::Invalid("comment key"))?;
            tx.execute(sql::DELETE_COMMENT, [seq])?;
            activity::comment_changed(tx, ctx, text(&copy, "parent_id")?, &json!(project))
        }
        "epic" => match local(tx, &EPIC, id, project)? {
            Some(row) => {
                api::delete_epic(tx, ctx, id, json!({"expected_revision": row["revision"]}))
                    .map(|_| ())
            }
            None => Ok(()),
        },
        "tag" => match local(tx, &TAG, id, project)? {
            Some(_) => api::tags::delete(tx, ctx, id).map(|_| ()),
            None => Ok(()),
        },
        "plan" => match local(tx, &PLAN, id, project)? {
            Some(row) => delete_plan(tx, ctx, project, &row),
            None => Ok(()),
        },
        _ => Ok(()),
    }
}
fn delete_plan(tx: &Transaction<'_>, ctx: &Context, project: &str, plan: &Value) -> Result<()> {
    let id = text(plan, "id")?;
    event(tx, ctx, "plan", id, number(plan, "revision")?, "delete")?;
    for epic in rows(tx, crate::work_queries::Query::PlanOverview.sql(), [id])? {
        let epic_id = text(&epic, "id")?;
        tx.execute(sql::CLEAR_PLAN, params![epic_id, ctx.now])?;
        event(
            tx,
            ctx,
            "work",
            epic_id,
            number(&epic, "revision")? + 1,
            "reorder",
        )?;
        if let Some(copy) = find(tx, sql::ENTITY, params![epic_id, project])? {
            let mut data = object(text(&copy, "data_json")?)?;
            data.insert("plan_id".into(), Value::Null);
            tx.execute(
                sql::SET_ENTITY_DATA,
                params![epic_id, Value::Object(data).to_string(), project],
            )?;
        }
    }
    tx.execute(sql::DELETE_PLAN, [id])?;
    count(tx, ("project", project), "plans", -1)?;
    api::bump_order(tx, ctx, None, project)
}

/// The epic_tag create branch: only when the epic and the tag both exist here.
pub(super) fn tag_link(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    item: &Item<'_>,
    quiet: bool,
) -> Result<()> {
    let (epic, tag) = (
        text_in(item.fields, "epic_id")?,
        text_in(item.fields, "tag_id")?,
    );
    let (Some(row), Some(_)) = (
        local(tx, &EPIC, epic, project)?,
        local(tx, &TAG, tag, project)?,
    ) else {
        return Ok(());
    };
    let data = pair("tag_id", epic, tag);
    put(
        tx,
        project,
        ("epic_tag", item.id, item.id, Some(epic)),
        item.revision,
        &data,
    )?;
    if tx.execute(api::sql::ASSIGN_TAG, params![epic, tag])? > 0 {
        retag(tx, ctx, &row, quiet)?;
    }
    Ok(())
}
/// Removes the local link once no live entity of the pair remains.
pub(super) fn unlink_pair(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    pair: &Map<String, Value>,
    quiet: bool,
) -> Result<()> {
    let (epic, tag) = (text_in(pair, "epic_id")?, text_in(pair, "tag_id")?);
    if !rows(tx, sql::PAIR_ENTITIES, params![epic, tag, project])?.is_empty() {
        return Ok(());
    }
    let Some(row) = local(tx, &EPIC, epic, project)? else {
        return Ok(());
    };
    if tx.execute(sql::UNLINK_TAG, params![epic, tag])? > 0 {
        retag(tx, ctx, &row, quiet)?;
    }
    Ok(())
}
fn retag(tx: &Transaction<'_>, ctx: &Context, epic: &Value, quiet: bool) -> Result<()> {
    let (id, revision) = (text(epic, "id")?, number(epic, "revision")?);
    tx.execute(api::sql::BUMP_EPIC, params![id, ctx.now, revision])?;
    event(tx, ctx, "work", id, revision + 1, "tags")?;
    if !quiet {
        activity::append(tx, ctx, id, "edited", text(epic, "title")?, None)?;
    }
    Ok(())
}
/// The comment append branch: once per entity, only under an epic of this project.
pub(super) fn comment(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    item: &Item<'_>,
) -> Result<()> {
    let epic = text_in(item.fields, "epic_id")?;
    if local(tx, &EPIC, epic, project)?.is_none()
        || find(tx, sql::ENTITY, params![item.id, project])?.is_some()
    {
        return Ok(());
    }
    let body = text_in(item.fields, "body")?;
    let seq = activity::record_comment(tx, ctx, epic, body)?;
    let data = pair("body", epic, body);
    put(
        tx,
        project,
        ("comment", item.id, &seq.to_string(), Some(epic)),
        item.revision,
        &data,
    )
}
/// Records values that lost to another person's edit, once.
pub(super) fn conflict(
    tx: &Transaction<'_>,
    ctx: &Context,
    spec: &Spec,
    id: &str,
    fields: &Map<String, Value>,
) -> Result<()> {
    let row = one(tx, spec.read, [id])?;
    let label = row["title"]
        .as_str()
        .or(row["name"].as_str())
        .unwrap_or_default();
    let body = json!({"conflict":true,"fields":fields}).to_string();
    activity::append(tx, ctx, id, "edited", label, Some(&body))
}
fn text_in<'a>(fields: &'a Map<String, Value>, name: &str) -> Result<&'a str> {
    fields
        .get(name)
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("missing text field"))
}
