//! Tags shared by every kind, and the counts that filter a listing.
use super::super::storage::AppStorageCode;
use super::AppStorageError;
use super::item::{self, failure, sql};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

/// Every tag with its item count: most used first, then by name.
pub(super) fn list(db: &Connection) -> Result<Value, AppStorageError> {
    let tags = counted(
        db,
        "SELECT g.name,COUNT(*) FROM browser_library_item_tag t JOIN browser_library_tag g ON g.norm=t.norm GROUP BY t.norm ORDER BY 2 DESC,g.name",
        &[],
    )?;
    Ok(json!({ "tags": tags }))
}

/// `[{name, count}]` rows of a two-column count query.
fn counted(db: &Connection, text: &str, args: &[&str]) -> Result<Vec<Value>, AppStorageError> {
    let mut statement = db.prepare(text).map_err(sql)?;
    statement
        .query_map(rusqlite::params_from_iter(args), |r| {
            Ok(json!({"name": r.get::<_, String>(0)?, "count": r.get::<_, i64>(1)?}))
        })
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}

/// Items carrying tag key `norm`.
fn tagged(db: &Connection, norm: &str) -> Result<Vec<String>, AppStorageError> {
    let mut statement = db
        .prepare("SELECT item_id FROM browser_library_item_tag WHERE norm=?1")
        .map_err(sql)?;
    statement
        .query_map([norm], |r| r.get(0))
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}

fn existing(db: &Connection, name: &str) -> Result<String, AppStorageError> {
    let norm = item::key(name);
    db.query_row(
        "SELECT norm FROM browser_library_tag WHERE norm=?1",
        [&norm],
        |r| r.get(0),
    )
    .optional()
    .map_err(sql)?
    .ok_or_else(|| failure(AppStorageCode::LibraryTagNotFound, "Tag not found."))
}

/// Renames tag `from` to `to`; when `to` exists already the two merge.
pub(super) fn rename(db: &Connection, from: &str, to: &str) -> Result<Value, AppStorageError> {
    let old = existing(db, from)?;
    let new = item::key(to);
    let items = tagged(db, &old)?;
    let merged = new != old
        && db
            .query_row(
                "SELECT 1 FROM browser_library_tag WHERE norm=?1",
                [&new],
                |_| Ok(()),
            )
            .optional()
            .map_err(sql)?
            .is_some();
    if new == old {
        db.execute(
            "UPDATE browser_library_tag SET name=?2 WHERE norm=?1",
            params![old, to.trim()],
        )
        .map_err(sql)?;
    } else {
        if !merged {
            db.execute(
                "INSERT INTO browser_library_tag(norm,name) VALUES(?1,?2)",
                params![new, to.trim()],
            )
            .map_err(sql)?;
        }
        db.execute("INSERT OR IGNORE INTO browser_library_item_tag(item_id,norm) SELECT item_id,?2 FROM browser_library_item_tag WHERE norm=?1", params![old, new]).map_err(sql)?;
        db.execute("DELETE FROM browser_library_item_tag WHERE norm=?1", [&old])
            .map_err(sql)?;
        db.execute("DELETE FROM browser_library_tag WHERE norm=?1", [&old])
            .map_err(sql)?;
    }
    item::refresh_all(db, &items)?;
    let (name, count): (String, i64) = db
        .query_row("SELECT g.name,(SELECT COUNT(*) FROM browser_library_item_tag t WHERE t.norm=g.norm) FROM browser_library_tag g WHERE g.norm=?1", [&new], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(sql)?;
    Ok(json!({"tag": {"name": name, "count": count}, "merged": merged}))
}

/// Removes tag `name` from every item.
pub(super) fn delete(db: &Connection, name: &str) -> Result<Value, AppStorageError> {
    let norm = existing(db, name)?;
    let items = tagged(db, &norm)?;
    db.execute(
        "DELETE FROM browser_library_item_tag WHERE norm=?1",
        [&norm],
    )
    .map_err(sql)?;
    db.execute("DELETE FROM browser_library_tag WHERE norm=?1", [&norm])
        .map_err(sql)?;
    item::refresh_all(db, &items)?;
    Ok(json!({"ok": true}))
}

/// Counts of `kind` (in group `group` when given: an id or `none`):
/// `{total, ungrouped, tags, sites}`; `ungrouped` is null for kinds without groups.
pub(super) fn facets(
    db: &Connection,
    kind: &str,
    group: Option<&str>,
) -> Result<Value, AppStorageError> {
    let kinds = json!(kind.split(',').collect::<Vec<_>>()).to_string();
    let (scope, args): (&str, Vec<&str>) = match group {
        None => ("l.kind IN (SELECT value FROM json_each(?1))", vec![&kinds]),
        Some("none") => (
            "l.kind IN (SELECT value FROM json_each(?1)) AND l.group_id IS NULL",
            vec![&kinds],
        ),
        Some(id) => (
            "l.kind IN (SELECT value FROM json_each(?1)) AND l.group_id=?2",
            vec![&kinds, id],
        ),
    };
    let count = |extra: &str| -> Result<i64, AppStorageError> {
        db.query_row(
            &format!("SELECT COUNT(*) FROM browser_library l WHERE {scope}{extra}"),
            rusqlite::params_from_iter(&args),
            |r| r.get(0),
        )
        .map_err(sql)
    };
    let total = count("")?;
    let ungrouped = if item::grouped(kind) {
        json!(count(" AND l.group_id IS NULL")?)
    } else {
        Value::Null
    };
    let tags = counted(
        db,
        &format!(
            "SELECT g.name,COUNT(*) FROM browser_library l JOIN browser_library_item_tag t ON t.item_id=l.id JOIN browser_library_tag g ON g.norm=t.norm WHERE {scope} GROUP BY t.norm ORDER BY 2 DESC,g.name"
        ),
        &args,
    )?;
    let sites = counted(
        db,
        &format!("SELECT l.site,COUNT(*) FROM browser_library l WHERE {scope} AND l.site<>'' GROUP BY l.site ORDER BY 2 DESC,l.site"),
        &args,
    )?
    .into_iter()
    .map(|row| json!({"site": row["name"], "count": row["count"]}))
    .collect::<Vec<_>>();
    Ok(json!({"total": total, "ungrouped": ungrouped, "tags": tags, "sites": sites}))
}
