//! Per-kind groups (scrap groups, bookmark folders): flat, user-ordered.
use super::super::storage::AppStorageCode;
use super::AppStorageError;
use super::item::{self, failure, sql};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::HashMap;

/// Items shown with each group.
const RECENT: i64 = 4;

/// `{groups, ungrouped, total}` of `kind`, groups in their order. One count
/// pass over the kind's group index plus one bounded read per group.
pub(super) fn overview(db: &Connection, kind: &str) -> Result<Value, AppStorageError> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    let mut ungrouped = 0;
    let mut statement = db
        .prepare("SELECT group_id,COUNT(*) FROM browser_library WHERE kind=?1 GROUP BY group_id")
        .map_err(sql)?;
    for row in statement
        .query_map([kind], |r| Ok((r.get::<_, Option<String>>(0)?, r.get(1)?)))
        .map_err(sql)?
    {
        match row.map_err(sql)? {
            (Some(id), count) => drop(counts.insert(id, count)),
            (None, count) => ungrouped = count,
        }
    }
    let total = ungrouped + counts.values().sum::<i64>();
    let mut statement = db
        .prepare("SELECT id FROM browser_library_group WHERE kind=?1 ORDER BY position,id")
        .map_err(sql)?;
    let ids = statement
        .query_map([kind], |r| r.get::<_, String>(0))
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    let groups = ids
        .iter()
        .map(|id| group(db, id, counts.get(id).copied().unwrap_or(0)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"groups": groups, "ungrouped": ungrouped, "total": total}))
}

/// One group with `count` items: `{id, kind, name, position, count, updatedAt, recent}`.
fn group(db: &Connection, id: &str, count: i64) -> Result<Value, AppStorageError> {
    let (kind, name, position, created): (String, String, i64, String) = db
        .query_row(
            "SELECT kind,name,position,created_at FROM browser_library_group WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(sql)?
        .ok_or_else(|| failure(AppStorageCode::LibraryGroupNotFound, "Group not found."))?;
    let mut statement = db
        .prepare_cached("SELECT payload FROM browser_library WHERE kind=?1 AND group_id=?2 ORDER BY created_at DESC,id DESC LIMIT ?3")
        .map_err(sql)?;
    let recent = statement
        .query_map(params![kind, id, RECENT], |r| r.get::<_, String>(0))
        .map_err(sql)?
        .map(|row| row.map_err(sql).and_then(|text| item::parse(&text)))
        .collect::<Result<Vec<_>, _>>()?;
    let updated = recent
        .first()
        .and_then(|item| item["capturedAt"].as_str())
        .map_or(created, str::to_owned);
    Ok(
        json!({"id": id, "kind": kind, "name": name, "position": position,
        "count": count, "updatedAt": updated, "recent": recent}),
    )
}

/// Group `id` with its current count.
pub(super) fn one(db: &Connection, id: &str) -> Result<Value, AppStorageError> {
    let kind = item::group_kind(db, id)?;
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM browser_library WHERE kind=?1 AND group_id=?2",
            [&kind, id],
            |r| r.get(0),
        )
        .map_err(sql)?;
    group(db, id, count)
}

/// Fails when another group of `kind` already has `name` (case-insensitively).
fn unique(
    db: &Connection,
    kind: &str,
    name: &str,
    own: Option<&str>,
) -> Result<(), AppStorageError> {
    match item::find_group(db, kind, name)? {
        Some(id) if Some(id.as_str()) != own => Err(failure(
            AppStorageCode::LibraryGroupExists,
            "A group with this name already exists.",
        )),
        _ => Ok(()),
    }
}

/// Creates group `name` of `kind`, last in its order.
pub(super) fn create(db: &Connection, kind: &str, name: &str) -> Result<Value, AppStorageError> {
    if !item::grouped(kind) {
        return Err(failure(
            AppStorageCode::InvalidLibraryRequest,
            "Only scraps and bookmarks have groups.",
        ));
    }
    unique(db, kind, name, None)?;
    let id = item::insert_group(db, kind, name)?;
    one(db, &id)
}

/// Renames group `id` and/or moves it to index `position`; others shift.
pub(super) fn update(
    db: &Connection,
    id: &str,
    name: Option<&str>,
    position: Option<usize>,
) -> Result<Value, AppStorageError> {
    let kind = item::group_kind(db, id)?;
    if let Some(name) = name {
        unique(db, &kind, name, Some(id))?;
        db.execute(
            "UPDATE browser_library_group SET name=?2,name_key=?3 WHERE id=?1",
            params![id, name.trim(), item::key(name)],
        )
        .map_err(sql)?;
        item::refresh_all(db, &item::members(db, &kind, id)?)?;
    }
    if let Some(position) = position {
        let mut order = order(db, &kind)?;
        order.retain(|other| other != id);
        order.insert(position.min(order.len()), id.to_owned());
        renumber(db, &order)?;
    }
    one(db, id)
}

/// Deletes group `id`; its items stay, ungrouped.
pub(super) fn delete(db: &Connection, id: &str) -> Result<Value, AppStorageError> {
    let kind = item::group_kind(db, id)?;
    let members = item::members(db, &kind, id)?;
    db.execute(
        "UPDATE browser_library SET group_id=NULL WHERE kind=?1 AND group_id=?2",
        [&kind, id],
    )
    .map_err(sql)?;
    db.execute("DELETE FROM browser_library_group WHERE id=?1", [id])
        .map_err(sql)?;
    renumber(db, &order(db, &kind)?)?;
    item::refresh_all(db, &members)?;
    Ok(json!({"ok": true}))
}

fn order(db: &Connection, kind: &str) -> Result<Vec<String>, AppStorageError> {
    let mut statement = db
        .prepare("SELECT id FROM browser_library_group WHERE kind=?1 ORDER BY position,id")
        .map_err(sql)?;
    statement
        .query_map([kind], |r| r.get(0))
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}

fn renumber(db: &Connection, order: &[String]) -> Result<(), AppStorageError> {
    let mut statement = db
        .prepare("UPDATE browser_library_group SET position=?2 WHERE id=?1 AND position<>?2")
        .map_err(sql)?;
    for (position, id) in order.iter().enumerate() {
        statement
            .execute(params![
                id,
                i64::try_from(position).map_err(|_| failure(
                    AppStorageCode::InvalidLibraryRequest,
                    "Too many groups."
                ))?
            ])
            .map_err(sql)?;
    }
    Ok(())
}
