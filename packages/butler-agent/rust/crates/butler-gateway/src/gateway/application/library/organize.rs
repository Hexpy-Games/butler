//! Filing, tagging and renaming saved items, in one transaction per call.
use super::super::storage::AppStorageCode;
use super::AppStorageError;
use super::item::{self, failure, sql};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// One organize call over `ids`; absent fields leave items unchanged.
#[derive(Clone, Debug, Default)]
pub struct AppLibraryChange {
    pub ids: Vec<String>,
    /// `Some(None)` ungroups; `Some(Some(_))` is a group id, or with
    /// `by_name` a group name created in the items' kind when missing.
    pub group: Option<Option<String>>,
    pub add_tags: Vec<String>,
    pub remove_tags: Vec<String>,
    /// A new name for the single item; empty restores its original title.
    pub title: Option<String>,
    /// The agent's call: groups by name and compact items in the result.
    pub by_name: bool,
}

/// Applies `change` and returns `{items}` (with `group` for the agent).
pub(super) fn apply(db: &Connection, change: &AppLibraryChange) -> Result<Value, AppStorageError> {
    if change.title.is_some() && change.ids.len() != 1 {
        return Err(failure(
            AppStorageCode::InvalidLibraryRequest,
            "A title renames exactly one item.",
        ));
    }
    let kinds = kinds(db, &change.ids)?;
    let (group, created) = match &change.group {
        None => (None, false),
        Some(None) => (Some(None), false),
        Some(Some(group)) => {
            let (id, created) = target(db, &kinds, group, change.by_name)?;
            (Some(Some(id)), created)
        }
    };
    let mut statement = db
        .prepare_cached("UPDATE browser_library SET group_id=?2 WHERE id=?1")
        .map_err(sql)?;
    for id in &change.ids {
        if let Some(group) = &group {
            statement.execute(params![id, group]).map_err(sql)?;
        }
        for tag in &change.add_tags {
            item::add_tag(db, id, tag)?;
        }
        for tag in &change.remove_tags {
            item::remove_tag(db, id, tag)?;
        }
    }
    if let (Some(title), [id]) = (&change.title, change.ids.as_slice()) {
        rename(db, id, title)?;
    }
    let items = item::refresh_all(db, &change.ids)?;
    if !change.by_name {
        return Ok(json!({ "items": items }));
    }
    let names = super::query::group_names(db, &items)?;
    let mut result = json!({
        "ok": true,
        "items": items.iter().map(|item| super::query::compact(item, &names)).collect::<Vec<_>>(),
    });
    if let Some(Some(id)) = &group {
        result["group"] = json!({"id": id, "name": names.get(id), "created": created});
    }
    Ok(result)
}

/// The distinct kinds of `ids`; every id must exist.
fn kinds(db: &Connection, ids: &[String]) -> Result<BTreeSet<String>, AppStorageError> {
    let mut statement = db
        .prepare_cached("SELECT kind FROM browser_library WHERE id=?1")
        .map_err(sql)?;
    let mut kinds = BTreeSet::new();
    for id in ids {
        let kind: String = statement
            .query_row([id], |r| r.get(0))
            .optional()
            .map_err(sql)?
            .ok_or_else(|| {
                failure(
                    AppStorageCode::LibraryItemNotFound,
                    format!("No saved item has id {id}."),
                )
            })?;
        kinds.insert(kind);
    }
    Ok(kinds)
}

/// The group items of `kinds` move into, and whether it was created now.
fn target(
    db: &Connection,
    kinds: &BTreeSet<String>,
    group: &str,
    by_name: bool,
) -> Result<(String, bool), AppStorageError> {
    let mismatch = |message: String| failure(AppStorageCode::LibraryGroupKindMismatch, message);
    if !by_name {
        let kind = item::group_kind(db, group)?;
        if kinds.iter().any(|other| *other != kind) {
            return Err(mismatch(format!(
                "The group holds {kind} items; every item must be a {kind} item."
            )));
        }
        return Ok((group.to_owned(), false));
    }
    let list = kinds.iter().cloned().collect::<Vec<_>>().join(", ");
    match kinds.iter().next() {
        Some(kind) if kinds.len() == 1 && item::grouped(kind) => {
            item::ensure_group(db, kind, group)
        }
        _ if kinds.len() > 1 => Err(mismatch(format!(
            "These items are of different kinds ({list}); groups hold one kind. Call again once per kind."
        ))),
        _ => Err(mismatch(format!(
            "Only scraps and bookmarks have groups; these items are {list}."
        ))),
    }
}

/// Renames item `id`; an empty title restores its original title.
fn rename(db: &Connection, id: &str, title: &str) -> Result<(), AppStorageError> {
    let payload: String = db
        .query_row(
            "SELECT payload FROM browser_library WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let mut item = item::parse(&payload)?;
    let title = title.trim();
    let original = item["autoTitle"]
        .as_str()
        .or(item["title"].as_str())
        .unwrap_or_default()
        .to_owned();
    let Some(object) = item.as_object_mut() else {
        return Ok(());
    };
    if title.is_empty() || title == original {
        object.insert("title".into(), json!(original));
        object.remove("autoTitle");
    } else {
        object.insert("autoTitle".into(), json!(original));
        object.insert("title".into(), json!(title));
    }
    db.execute(
        "UPDATE browser_library SET payload=?2 WHERE id=?1",
        params![id, item.to_string()],
    )
    .map_err(sql)?;
    Ok(())
}
