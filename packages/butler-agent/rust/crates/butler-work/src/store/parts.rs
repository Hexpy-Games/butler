//! Hidden part DAGs. Structure edits validate the complete affected Task DAG.
use super::{execution::sql, *};
use crate::work_types::TaskKind;
use rusqlite::params;
use std::collections::BTreeSet;

pub fn read_part(db: &Connection, id: &str) -> Result<Value> {
    one(db, sql::PART, [id])
}
pub fn task_parts(db: &Connection, task: &str) -> Result<Vec<Value>> {
    rows(db, sql::PARTS, [task])
}
pub fn part_edges(db: &Connection, task: &str) -> Result<Vec<Value>> {
    rows(db, sql::PART_EDGES, [task])
}
pub struct NewPart<'a> {
    pub id: &'a str,
    pub task_id: &'a str,
    pub kind: TaskKind,
    pub title: &'a str,
    pub after_part_ids: &'a [String],
}
pub fn add_part(tx: &Transaction<'_>, ctx: &Context, input: &NewPart<'_>) -> Result<Value> {
    editable_task(tx, input.task_id)?;
    let all = task_parts(tx, input.task_id)?;
    let last = all.last().and_then(|p| p["part_rank"].as_str());
    // Part order is append-only. Imported ranks need not use the fractional
    // alphabet; extending any existing string still orders strictly after it.
    let rank = crate::work_rank::between(last, None)
        .or_else(|| last.map(|rank| format!("{rank}V")))
        .ok_or(Error::InvalidRank)?;
    validate_dag(tx, input.task_id, input.id, input.after_part_ids)?;
    tx.execute(
        sql::INSERT_PART,
        params![
            input.id,
            input.task_id,
            input.kind.as_str(),
            input.title,
            rank
        ],
    )?;
    write_predecessors(tx, input.task_id, input.id, input.after_part_ids)?;
    touch_task(tx, ctx, input.task_id)?;
    event(tx, ctx, "part", input.id, 0, "add")?;
    read_part(tx, input.id)
}
pub fn edit_part(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected: i64,
    title: Option<&str>,
    after: Option<&[String]>,
) -> Result<Value> {
    let part = read_part(tx, id)?;
    cas(&part, "revision", expected)?;
    let task = text(&part, "task_id")?;
    editable_task(tx, task)?;
    if matches!(
        part["status"].as_str(),
        Some("running" | "completed" | "cancelled")
    ) {
        return Err(Error::Running);
    }
    if let Some(after) = after {
        validate_dag(tx, task, id, after)?;
        write_predecessors(tx, task, id, after)?;
    }
    tx.execute(
        sql::EDIT_PART,
        params![id, title.unwrap_or(text(&part, "title")?), expected],
    )?;
    touch_task(tx, ctx, task)?;
    event(tx, ctx, "part", id, expected + 1, "edit")?;
    read_part(tx, id)
}
pub fn remove_part(tx: &Transaction<'_>, ctx: &Context, id: &str, expected: i64) -> Result<()> {
    let part = read_part(tx, id)?;
    cas(&part, "revision", expected)?;
    let task = text(&part, "task_id")?;
    editable_task(tx, task)?;
    if matches!(part["status"].as_str(), Some("running" | "completed")) {
        return Err(Error::Running);
    }
    tx.execute(sql::REMOVE_PART_EDGES, params![task, id])?;
    tx.execute(
        sql::PART_STATE,
        params![id, "cancelled", Option::<&str>::None],
    )?;
    touch_task(tx, ctx, task)?;
    event(tx, ctx, "part", id, expected + 1, "remove")
}
pub(super) fn editable_task(db: &Connection, id: &str) -> Result<Value> {
    let row = read_task(db, id)?;
    if matches!(row["status"].as_str(), Some("completed" | "cancelled")) {
        return Err(Error::Invalid("terminal Task"));
    }
    Ok(row)
}
pub(super) fn touch_task(tx: &Transaction<'_>, ctx: &Context, id: &str) -> Result<()> {
    // Part structure is part of the Task's review snapshot, so every edit
    // invalidates an earlier result/review through its Task revision.
    let row = read_task(tx, id)?;
    tx.execute(
        super::sql::STATE,
        params![
            id,
            text(&row, "status")?,
            row["hold_reason"].as_str(),
            row["held_by_task_id"].as_str(),
            row["failure_reason"].as_str(),
            row["result_reported_at"].as_i64(),
            ctx.now,
            row["revision"].as_i64()
        ],
    )?;
    event(
        tx,
        ctx,
        "task",
        id,
        row["revision"].as_i64().ok_or(Error::Invalid("revision"))? + 1,
        "parts",
    )
}
fn write_predecessors(tx: &Transaction<'_>, task: &str, id: &str, after: &[String]) -> Result<()> {
    tx.execute(sql::REMOVE_PART_PREDS, params![task, id])?;
    for pred in after {
        tx.execute(sql::INSERT_PART_EDGE, params![task, pred, id])?;
    }
    Ok(())
}
fn validate_dag(db: &Connection, task: &str, id: &str, after: &[String]) -> Result<()> {
    let mut nodes: Vec<String> = task_parts(db, task)?
        .iter()
        .filter(|p| p["status"] != "cancelled")
        .map(|p| Ok(text(p, "id")?.to_owned()))
        .collect::<Result<_>>()?;
    if !nodes.iter().any(|node| node == id) {
        nodes.push(id.into());
    }
    let unique: BTreeSet<_> = after.iter().collect();
    if unique.len() != after.len() {
        return Err(Error::Invalid("duplicate part predecessor"));
    }
    let mut edges = part_edges(db, task)?
        .iter()
        .filter(|e| e["succ"] != id)
        .map(|e| Ok((text(e, "pred")?.to_owned(), text(e, "succ")?.to_owned())))
        .collect::<Result<Vec<_>>>()?;
    for pred in after {
        if !nodes.contains(pred) {
            return Err(Error::Invalid(
                "part predecessor belongs to another Task or was removed",
            ));
        }
        edges.push((pred.clone(), id.into()));
    }
    crate::work_chain::validate_part_dag(&nodes, &edges).map_err(|_| Error::PartCycle {
        task: task.to_owned(),
        path: cycle_path(id, &edges),
    })
}

/// Existing edges are acyclic; an edit replaces only this part's incoming
/// edges, so any new cycle passes through it.
fn cycle_path(id: &str, edges: &[(String, String)]) -> Vec<String> {
    use std::collections::{BTreeMap, VecDeque};
    let mut outgoing: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (pred, succ) in edges {
        outgoing.entry(pred).or_default().push(succ);
    }
    let mut parents: BTreeMap<&str, Option<&str>> = BTreeMap::from([(id, None)]);
    let mut queue = VecDeque::from([id]);
    while let Some(node) = queue.pop_front() {
        for &next in outgoing.get(node).into_iter().flatten() {
            if next == id {
                let mut path = vec![node.to_owned()];
                let mut previous = node;
                while let Some(Some(parent)) = parents.get(previous) {
                    path.push((*parent).to_owned());
                    previous = parent;
                }
                path.reverse();
                path.push(id.to_owned());
                return path;
            }
            if let std::collections::btree_map::Entry::Vacant(entry) = parents.entry(next) {
                entry.insert(Some(node));
                queue.push_back(next);
            }
        }
    }
    Vec::new()
}
