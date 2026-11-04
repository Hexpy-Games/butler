use super::*;
use rusqlite::params;
use serde::{Deserialize, Deserializer};
use std::collections::BTreeSet;

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct PlanInput {
    expected_revision: Option<i64>,
    title: Option<String>,
    description: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    due_on: Option<Option<String>>,
    status: Option<PlanStatus>,
}
fn nullable<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}
fn person(ctx: &Context) -> Result<UserAct> {
    Ok(UserAct::new(text(&ctx.actor, "person")?))
}
fn fields(input: PlanInput, old: Option<&Value>) -> Result<PlanFields> {
    let fields = PlanFields {
        title: input
            .title
            .or_else(|| old.and_then(|v| v["title"].as_str().map(str::to_owned)))
            .unwrap_or_default(),
        description: input
            .description
            .or_else(|| old.and_then(|v| v["description"].as_str().map(str::to_owned)))
            .unwrap_or_default(),
        due_on: input
            .due_on
            .unwrap_or_else(|| old.and_then(|v| v["due_on"].as_str().map(str::to_owned))),
        status: input.status.unwrap_or_else(|| {
            if old.is_some_and(|v| v["status"] == "closed") {
                PlanStatus::Closed
            } else {
                PlanStatus::Open
            }
        }),
    };
    title(&fields.title)?;
    if fields.due_on.as_ref().is_some_and(|s| !valid_date(s)) {
        return Err(Error::Invalid("due_on must be YYYY-MM-DD"));
    }
    Ok(fields)
}
fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    let year = value[..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..].parse::<u32>().unwrap_or(0);
    let max = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    year > 0 && day > 0 && day <= max
}
pub(super) fn create_plan(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    value: Value,
) -> Result<Value> {
    let input: PlanInput = input(value)?;
    if input.expected_revision.is_some() {
        return Err(Error::Invalid("create has no expected_revision"));
    }
    let id = IdGenerator::global_next(IdKind::Plan, ctx.now)?;
    super::super::create_plan(
        tx,
        ctx,
        &id,
        project,
        &fields(input, None)?,
        &Registration::Canon(person(ctx)?),
    )?;
    plan(tx, &id)
}
pub(super) fn edit_plan(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    value: Value,
) -> Result<Value> {
    let input: PlanInput = input(value)?;
    let expected = input
        .expected_revision
        .ok_or(Error::Invalid("expected_revision required"))?;
    let old = canon_row(read_plan(tx, id)?)?;
    super::super::edit_plan(tx, ctx, id, expected, &fields(input, Some(&old))?)?;
    plan(tx, id)
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct EpicInput {
    expected_revision: Option<i64>,
    title: Option<String>,
    description: Option<String>,
    status: Option<CanonStatus>,
    #[serde(default, deserialize_with = "nullable")]
    assignee: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    plan_id: Option<Option<String>>,
    before_id: Option<String>,
    tags: Option<Vec<String>>,
}
pub(super) fn create_epic(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    value: Value,
) -> Result<Value> {
    let input: EpicInput = input(value)?;
    if input.expected_revision.is_some() || input.status.is_some() {
        return Err(Error::Invalid("invalid creation fields"));
    }
    let title_value = input.title.clone().unwrap_or_default();
    title(&title_value)?;
    let id = IdGenerator::global_next(IdKind::Work, ctx.now)?;
    super::super::entities::insert_work_assigned(
        tx,
        ctx,
        &NewWork {
            id: id.clone(),
            project_id: project.into(),
            title: title_value,
            description: input.description.clone().unwrap_or_default(),
            origin: if ctx.actor["origin"] == "mcp" {
                Origin::Mcp
            } else if ctx.actor["origin"] == "chat" {
                Origin::Chat
            } else {
                Origin::Dialog
            },
        },
        &Registration::Canon(person(ctx)?),
        input.assignee.as_ref().and_then(|v| v.as_deref()),
        input.tags.as_deref().unwrap_or_default(),
    )?;
    position(
        tx,
        ctx,
        &id,
        input.plan_id.as_ref().and_then(|v| v.as_deref()),
        input.before_id.as_deref(),
    )?;
    epic(tx, &id)
}
pub(super) fn edit_epic(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    value: Value,
) -> Result<Value> {
    let input: EpicInput = input(value)?;
    let old = canon_row(read_work(tx, id)?)?;
    cas(
        &old,
        "revision",
        input
            .expected_revision
            .ok_or(Error::Invalid("expected_revision required"))?,
    )?;
    if let Some(tags) = &input.tags {
        tags::replace(tx, ctx, &read_work(tx, id)?, tags)?;
    }
    if input.plan_id.is_some() || input.before_id.is_some() {
        let dest = input
            .plan_id
            .as_ref()
            .map(|v| v.as_deref())
            .unwrap_or(old["plan_id"].as_str());
        position(tx, ctx, id, dest, input.before_id.as_deref())?;
    }
    let row = read_work(tx, id)?;
    edit_fields(tx, ctx, id, &row, &input)?;
    if let Some(status) = input.status {
        let row = read_work(tx, id)?;
        set_label(tx, ctx, id, revision(&row)?, status, &person(ctx)?)?;
    }
    epic(tx, id)
}
fn edit_fields(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    row: &Value,
    input: &EpicInput,
) -> Result<()> {
    if input.title.is_none() && input.description.is_none() && input.assignee.is_none() {
        return Ok(());
    }
    let mut fields = WorkFields::from_snapshot(row)?;
    if let Some(s) = &input.title {
        title(s)?;
        fields.title = s.clone();
    }
    if let Some(s) = &input.description {
        fields.description = s.clone();
    }
    if let Some(s) = &input.assignee {
        fields.assignee = s.clone();
    }
    edit_work(tx, ctx, id, revision(row)?, &fields)?;
    Ok(())
}
fn container(db: &Connection, plan: Option<&str>, project: &str) -> Result<Vec<Value>> {
    let q = if plan.is_some() {
        Query::PlanOverview
    } else {
        Query::Backlog
    };
    rows(db, q.sql(), [plan.unwrap_or(project)])
}
pub(super) fn bump_order(
    tx: &Transaction<'_>,
    ctx: &Context,
    plan: Option<&str>,
    project: &str,
) -> Result<()> {
    if let Some(id) = plan {
        tx.execute(sql::BUMP_PLAN, params![id, ctx.now])?;
        event(tx, ctx, "plan", id, revision(&read_plan(tx, id)?)?, "order")?;
    } else {
        tx.execute(sql::BUMP_BACKLOG, [project])?;
        event(
            tx,
            ctx,
            "backlog",
            project,
            reads::backlog_revision(tx, project)?,
            "order",
        )?;
    }
    Ok(())
}
fn position(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    plan: Option<&str>,
    before: Option<&str>,
) -> Result<()> {
    let row = read_work(tx, id)?;
    let project = text(&row, "project_id")?;
    if let Some(plan) = plan {
        canon_row(read_plan(tx, plan)?)?;
    }
    let works: Vec<_> = container(tx, plan, project)?
        .into_iter()
        .filter(|w| w["id"] != id)
        .collect();
    let index = match before {
        Some(before) => works
            .iter()
            .position(|w| w["id"] == before)
            .ok_or(Error::Invalid("before_id is outside destination"))?,
        None => works.len(),
    };
    let lower = index
        .checked_sub(1)
        .and_then(|i| works[i]["plan_rank"].as_str());
    let upper = works.get(index).and_then(|w| w["plan_rank"].as_str());
    set_plan_rank(tx, ctx, id, revision(&row)?, plan, lower, upper)?;
    let old = row["plan_id"].as_str();
    if old != plan {
        bump_order(tx, ctx, old, project)?;
    }
    bump_order(tx, ctx, plan, project)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Order {
    work_ids: Vec<String>,
    expected_revision: i64,
}
/// Backlog uses a project counter; plan uses its entity revision. Membership
/// changes bump these tokens too, preventing stale orders from dropping cards.
pub(super) fn order(
    tx: &Transaction<'_>,
    ctx: &Context,
    plan_id: Option<&str>,
    id: &str,
    value: Value,
) -> Result<Value> {
    let order: Order = input(value)?;
    let plan_row = plan_id
        .map(|id| read_plan(tx, id).and_then(canon_row))
        .transpose()?;
    let project = plan_row
        .as_ref()
        .map(|v| text(v, "project_id"))
        .transpose()?
        .unwrap_or(id);
    let rev = match &plan_row {
        Some(row) => revision(row)?,
        None => reads::backlog_revision(tx, project)?,
    };
    cas(
        &json!({"revision":rev}),
        "revision",
        order.expected_revision,
    )?;
    let works = container(tx, plan_id, project)?;
    let actual: BTreeSet<_> = works.iter().filter_map(|v| v["id"].as_str()).collect();
    let wanted: BTreeSet<_> = order.work_ids.iter().map(String::as_str).collect();
    if actual != wanted || wanted.len() != order.work_ids.len() {
        return Err(Error::Invalid("order must contain every card exactly once"));
    }
    let mut lower = None;
    for id in order.work_ids {
        let row = read_work(tx, &id)?;
        let updated = set_plan_rank(
            tx,
            ctx,
            &id,
            revision(&row)?,
            plan_id,
            lower.as_deref(),
            None,
        )?;
        lower = Some(text(&updated, "plan_rank")?.to_owned());
    }
    bump_order(tx, ctx, plan_id, project)?;
    if let Some(id) = plan_id {
        plan(tx, id)
    } else {
        canon(tx, project)
    }
}
