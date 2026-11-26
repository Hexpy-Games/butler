//! Canon online sync: space links, the strict FIFO outbox, stored copies of
//! synced entities, and remote apply. Session links, the queue, intents, MCP
//! grants, proposals, specs and attachments are never synced.
mod apply;
mod capture;
pub mod sql;
use super::*;
pub(super) use capture::{capture, capture_comment};
use rusqlite::params;
use std::collections::HashSet;

#[derive(Debug, Default)]
pub struct Recorded {
    pub accepted: bool,
    pub failed: Vec<String>,
}
#[derive(Debug, Default)]
pub struct Applied {
    pub cursor: i64,
    pub gap: bool,
    pub skipped: Vec<String>,
    pub missing: bool,
}

fn find(db: &Connection, statement: &str, params: impl Params) -> Result<Option<Value>> {
    Ok(rows(db, statement, params)?.into_iter().next())
}
/// Runs `step` in its own savepoint; a failed step is rolled back alone.
fn savepoint(tx: &Transaction<'_>, name: &str, step: impl FnOnce() -> Result<()>) -> Result<bool> {
    tx.execute_batch(&format!("SAVEPOINT {name}"))?;
    let applied = step().is_ok();
    if !applied {
        tx.execute_batch(&format!("ROLLBACK TO {name}"))?;
    }
    tx.execute_batch(&format!("RELEASE {name}"))?;
    Ok(applied)
}
fn number(row: &Value, field: &str) -> Result<i64> {
    row[field]
        .as_i64()
        .ok_or(Error::Invalid("missing number field"))
}
fn object(text: &str) -> Result<serde_json::Map<String, Value>> {
    Ok(serde_json::from_str(text)?)
}

pub fn links(db: &Connection) -> Result<Vec<Value>> {
    let mut links = rows(db, sql::LINKS, [])?;
    for link in &mut links {
        let pending = one(db, sql::OUTBOX_PENDING, [text(link, "space_id")?])?;
        link["pending"] = pending["n"].clone();
    }
    Ok(links)
}
pub fn link_by_project(db: &Connection, project: &str) -> Result<Option<Value>> {
    find(db, sql::LINK, [project])
}
pub fn link_by_space(db: &Connection, space: &str) -> Result<Option<Value>> {
    find(db, sql::LINK_BY_SPACE, [space])
}
pub fn project_used(db: &Connection, project: &str) -> Result<bool> {
    Ok(db.query_row(sql::PROJECT_USED, [project], |r| r.get(0))?)
}

/// Links a local project to a new, empty space and queues every synced entity
/// as a create, parents first.
pub fn link(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    space: &str,
    account: &str,
) -> Result<()> {
    if link_by_project(tx, project)?.is_some() {
        return Err(Error::Invalid("project is already online"));
    }
    tx.execute(
        sql::INSERT_LINK,
        params![project, space, account, "owner", 0, ctx.now],
    )?;
    for (statement, kind) in [
        (sql::EXPORT_PLANS, "plan"),
        (sql::EXPORT_TAGS, "tag"),
        (sql::EXPORT_EPICS, "work"),
    ] {
        for row in rows(tx, statement, [project])? {
            capture(tx, ctx, kind, text(&row, "id")?, "create")?;
        }
    }
    for row in rows(tx, sql::EXPORT_COMMENTS, [project])? {
        let (epic, seq) = (text(&row, "entity_id")?, number(&row, "seq")?);
        capture_comment(tx, ctx, epic, seq, text(&row, "body")?)?;
    }
    Ok(())
}

/// Joins a space into a new, empty local project. Returns the snapshot
/// entities that were skipped (scope or constraint failures).
pub fn join(
    tx: &Transaction<'_>,
    me: &Context,
    project: &str,
    space: &str,
    account: &str,
    role: &str,
    snapshot: &Value,
) -> Result<Vec<String>> {
    if link_by_project(tx, project)?.is_some() {
        return Err(Error::Invalid("project is already online"));
    }
    if project_used(tx, project)? {
        return Err(Error::Invalid("join into a new, empty project"));
    }
    let head = number(snapshot, "head_seq")?;
    tx.execute(
        sql::INSERT_LINK,
        params![project, space, account, role, head, me.now],
    )?;
    apply::replace_all(tx, me, project, space, snapshot)
}
pub fn unlink(tx: &Transaction<'_>, project: &str) -> Result<()> {
    if let Some(link) = link_by_project(tx, project)? {
        tx.execute(sql::OUTBOX_DELETE_SPACE, [text(&link, "space_id")?])?;
        tx.execute(sql::DELETE_PROJECT_ENTITIES, [project])?;
        tx.execute(sql::DELETE_LINK, [project])?;
    }
    Ok(())
}
pub fn set_state(tx: &Transaction<'_>, space: &str, state: &str) -> Result<()> {
    tx.execute(sql::SET_STATE, params![space, state])?;
    Ok(())
}
pub fn set_role(tx: &Transaction<'_>, space: &str, role: &str) -> Result<()> {
    tx.execute(sql::SET_ROLE, params![space, role])?;
    Ok(())
}
/// A 403 from the server: the account is a viewer now. Drops the queue and
/// the copies the server never acknowledged; returns the dropped op count.
pub fn demote(tx: &Transaction<'_>, space: &str) -> Result<usize> {
    let Some(link) = link_by_space(tx, space)? else {
        return Ok(0);
    };
    tx.execute(sql::SET_ROLE, params![space, "viewer"])?;
    tx.execute(sql::SET_RESYNC_PENDING, params![space, 1])?;
    let dropped = tx.execute(sql::OUTBOX_DELETE_SPACE, [space])?;
    tx.execute(sql::DELETE_UNACKED_ENTITIES, [text(&link, "project_id")?])?;
    Ok(dropped)
}
pub fn mark_resync(tx: &Transaction<'_>, space: &str) -> Result<()> {
    tx.execute(sql::SET_RESYNC_PENDING, params![space, 1])?;
    Ok(())
}

pub fn has_sendable(db: &Connection, space: &str) -> Result<bool> {
    let Some(row) = find(db, sql::OUTBOX_QUEUE, params![space, 1])? else {
        return Ok(false);
    };
    let entity = text(&row, "entity_id")?;
    Ok(find(db, sql::OUTBOX_ENTITY_ACKED, params![entity, space])?.is_none())
}

/// The next batch in queue order: at most one op per entity, never an entity
/// with an accepted op the stream has not consumed. Taken rows are frozen.
pub fn take_sendable(tx: &Transaction<'_>, space: &str) -> Result<Vec<Value>> {
    let Some(link) = link_by_space(tx, space)? else {
        return Ok(Vec::new());
    };
    let project = text(&link, "project_id")?;
    let (mut batch, mut size, mut entities) = (Vec::new(), 0, HashSet::new());
    for row in rows(tx, sql::OUTBOX_QUEUE, params![space, 100])? {
        let (op_id, entity, action) = (
            text(&row, "op_id")?,
            text(&row, "entity_id")?,
            text(&row, "action")?,
        );
        if entities.contains(entity)
            || find(tx, sql::OUTBOX_ENTITY_ACKED, params![entity, space])?.is_some()
        {
            break;
        }
        let base = match row["base_revision"].as_i64() {
            Some(base) => base,
            None if matches!(action, "set" | "move") => {
                match find(tx, sql::ENTITY, params![entity, project])? {
                    Some(copy) => number(&copy, "sync_revision")?,
                    None => {
                        tx.execute(sql::OUTBOX_DELETE, [op_id])?;
                        continue;
                    }
                }
            }
            None => 0,
        };
        let op = json!({"op_id":op_id,"entity_id":entity,"kind":row["kind"],"action":action,
            "base_revision":base,"fields":object(text(&row, "fields_json")?)?});
        size += serde_json::to_vec(&op)?.len();
        if size > 900_000 {
            break;
        }
        if row["base_revision"].is_null() {
            tx.execute(sql::OUTBOX_SET_BASE, params![op_id, base])?;
        }
        entities.insert(entity.to_owned());
        batch.push(op);
    }
    Ok(batch)
}

/// Records the server's answer to one batch. A result that fails locally is
/// rolled back alone; its entity's queued ops are dropped and reported.
pub fn record_results(
    tx: &Transaction<'_>,
    me: &Context,
    space: &str,
    results: &[Value],
) -> Result<Recorded> {
    let mut recorded = Recorded::default();
    let Some(link) = link_by_space(tx, space)? else {
        return Ok(recorded);
    };
    let (project, cursor) = (text(&link, "project_id")?, number(&link, "cursor_seq")?);
    for result in results {
        let Some(row) = find(tx, sql::OUTBOX_OP, params![text(result, "op_id")?, space])? else {
            continue;
        };
        let (op_id, entity) = (text(&row, "op_id")?, text(&row, "entity_id")?);
        let accepted = result["status"] == "accepted";
        recorded.accepted |= accepted;
        let recorded_ok = savepoint(tx, "sync_result", || {
            if !accepted {
                return apply::reject(tx, me, project, space, &row, &result["current"]);
            }
            let seq = number(result, "seq")?;
            if seq <= cursor {
                let revision = number(result, "revision")?;
                tx.execute(sql::RAISE_SYNC_REVISION, params![entity, revision, project])?;
                tx.execute(sql::OUTBOX_DELETE, [op_id])?;
            } else {
                tx.execute(sql::OUTBOX_ACK, params![op_id, seq])?;
            }
            Ok(())
        })?;
        if !recorded_ok {
            tx.execute(sql::OUTBOX_DELETE_ENTITY, params![entity, space])?;
            tx.execute(sql::DELETE_ENTITY_IF_UNACKED, params![entity, project])?;
            recorded.failed.push(op_id.to_owned());
        }
    }
    Ok(recorded)
}

/// Applies stream records in `seq` order from the link's cursor.
pub fn apply(
    tx: &Transaction<'_>,
    space: &str,
    records: &[Value],
    members: &serde_json::Map<String, Value>,
    now: i64,
) -> Result<Applied> {
    apply::records(tx, space, records, members, now)
}

/// Replaces local state with a snapshot, then replays the unsent queue.
/// `None` when the link is gone; otherwise the skipped entity and op ids.
pub fn resync(
    tx: &Transaction<'_>,
    me: &Context,
    space: &str,
    snapshot: &Value,
) -> Result<Option<Vec<String>>> {
    let Some(link) = link_by_space(tx, space)? else {
        return Ok(None);
    };
    tx.execute(sql::OUTBOX_DELETE_ACKED, [space])?;
    let skipped = apply::replace_all(tx, me, text(&link, "project_id")?, space, snapshot)?;
    tx.execute(
        sql::SET_CURSOR,
        params![space, number(snapshot, "head_seq")?],
    )?;
    tx.execute(sql::SET_RESYNC_PENDING, params![space, 0])?;
    Ok(Some(skipped))
}
