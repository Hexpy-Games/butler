//! One Library item's derived state: its group, tags, sort keys and search terms.
//!
//! The stored payload is what pages return, so every write that changes an
//! item's group, tags or title ends with [`refresh`], which rewrites the payload
//! and the mirrored columns and search terms from the row, group and tag tables.
use super::super::storage::AppStorageCode;
use super::AppStorageError;
use butler_core::search_text::analyze_search_field;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

/// The case-insensitive NFKC key of a group or tag name.
pub(super) fn key(name: &str) -> String {
    name.trim().nfkc().collect::<String>().to_lowercase()
}
pub(super) fn failure(code: AppStorageCode, message: impl Into<String>) -> AppStorageError {
    AppStorageError::new(code, message)
}
pub(super) fn sql(error: rusqlite::Error) -> AppStorageError {
    AppStorageError::sqlite(error)
}
pub(super) fn parse(text: &str) -> Result<Value, AppStorageError> {
    serde_json::from_str(text).map_err(|e| failure(AppStorageCode::AppJsonFailed, e.to_string()))
}
/// Kinds whose items can be filed into groups.
pub(super) fn grouped(kind: &str) -> bool {
    matches!(kind, "scrap" | "bookmark")
}
pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
/// A scrap's page site, a bookmark's host; other kinds have none.
fn site(item: &Value) -> String {
    match item["kind"].as_str() {
        Some("scrap") => item["site"].as_str().unwrap_or_default().to_owned(),
        Some("bookmark") => item["url"]
            .as_str()
            .and_then(|url| url::Url::parse(url).ok())
            .and_then(|url| url.host_str().map(str::to_owned))
            .unwrap_or_default(),
        _ => String::new(),
    }
}
/// The kind of group `id`, or `library_group_not_found`.
pub(super) fn group_kind(db: &Connection, id: &str) -> Result<String, AppStorageError> {
    db.query_row(
        "SELECT kind FROM browser_library_group WHERE id=?1",
        [id],
        |r| r.get(0),
    )
    .optional()
    .map_err(sql)?
    .ok_or_else(|| failure(AppStorageCode::LibraryGroupNotFound, "Group not found."))
}
/// Fails unless group `id` exists and holds items of `kind`.
pub(super) fn check_group(db: &Connection, id: &str, kind: &str) -> Result<(), AppStorageError> {
    if group_kind(db, id)? == kind {
        return Ok(());
    }
    Err(failure(
        AppStorageCode::LibraryGroupKindMismatch,
        format!("This group holds other items than {kind} items."),
    ))
}
/// The group of `kind` named `name` (case-insensitively), if any.
pub(super) fn find_group(
    db: &Connection,
    kind: &str,
    name: &str,
) -> Result<Option<String>, AppStorageError> {
    db.query_row(
        "SELECT id FROM browser_library_group WHERE kind=?1 AND name_key=?2",
        params![kind, key(name)],
        |r| r.get(0),
    )
    .optional()
    .map_err(sql)
}
/// Creates group `name` last in its kind's order.
pub(super) fn insert_group(
    db: &Connection,
    kind: &str,
    name: &str,
) -> Result<String, AppStorageError> {
    let id = format!("group-{}", uuid::Uuid::new_v4().simple());
    db.execute(
        "INSERT INTO browser_library_group(id,kind,name,name_key,position,created_at) VALUES(?1,?2,?3,?4,(SELECT COALESCE(MAX(position)+1,0) FROM browser_library_group WHERE kind=?2),?5)",
        params![id, kind, name.trim(), key(name), now()],
    )
    .map_err(sql)?;
    Ok(id)
}
/// The group of `kind` named `name`, created last when missing; true when created.
pub(super) fn ensure_group(
    db: &Connection,
    kind: &str,
    name: &str,
) -> Result<(String, bool), AppStorageError> {
    match find_group(db, kind, name)? {
        Some(id) => Ok((id, false)),
        None => insert_group(db, kind, name).map(|id| (id, true)),
    }
}
/// Gives `item_id` tag `name`; a new tag keeps this first spelling.
pub(super) fn add_tag(db: &Connection, item_id: &str, name: &str) -> Result<(), AppStorageError> {
    let norm = key(name);
    db.prepare_cached("INSERT OR IGNORE INTO browser_library_tag(norm,name) VALUES(?1,?2)")
        .and_then(|mut s| s.execute(params![norm, name.trim()]))
        .map_err(sql)?;
    db.prepare_cached("INSERT OR IGNORE INTO browser_library_item_tag(item_id,norm) VALUES(?1,?2)")
        .and_then(|mut s| s.execute(params![item_id, norm]))
        .map_err(sql)?;
    Ok(())
}
/// Removes tag `name` from `item_id`; the tag goes when no item has it.
pub(super) fn remove_tag(
    db: &Connection,
    item_id: &str,
    name: &str,
) -> Result<(), AppStorageError> {
    let norm = key(name);
    db.prepare_cached("DELETE FROM browser_library_item_tag WHERE item_id=?1 AND norm=?2")
        .and_then(|mut s| s.execute(params![item_id, norm]))
        .map_err(sql)?;
    prune_tag(db, &norm)
}
pub(super) fn prune_tag(db: &Connection, norm: &str) -> Result<(), AppStorageError> {
    db.prepare_cached("DELETE FROM browser_library_tag WHERE norm=?1 AND NOT EXISTS(SELECT 1 FROM browser_library_item_tag WHERE norm=?1)")
        .and_then(|mut s| s.execute([norm]))
        .map(|_| ())
        .map_err(sql)
}
/// The tag keys of `item_id`.
pub(super) fn tag_keys(db: &Connection, item_id: &str) -> Result<Vec<String>, AppStorageError> {
    let mut statement = db
        .prepare_cached("SELECT norm FROM browser_library_item_tag WHERE item_id=?1")
        .map_err(sql)?;
    statement
        .query_map([item_id], |r| r.get(0))
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}
/// Replaces every tag of `item_id` with `names`.
pub(super) fn replace_tags(
    db: &Connection,
    item_id: &str,
    names: &[String],
) -> Result<(), AppStorageError> {
    let old = tag_keys(db, item_id)?;
    db.execute(
        "DELETE FROM browser_library_item_tag WHERE item_id=?1",
        [item_id],
    )
    .map_err(sql)?;
    for name in names {
        add_tag(db, item_id, name)?;
    }
    for norm in old {
        prune_tag(db, &norm)?;
    }
    Ok(())
}
/// Ids of the items in group `id` of `kind`.
pub(super) fn members(
    db: &Connection,
    kind: &str,
    id: &str,
) -> Result<Vec<String>, AppStorageError> {
    let mut statement = db
        .prepare("SELECT id FROM browser_library WHERE kind=?1 AND group_id=?2")
        .map_err(sql)?;
    statement
        .query_map([kind, id], |r| r.get(0))
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}
/// Rewrites item `id`'s payload (`group`, `tags`, a bookmark's `site` and
/// `folder`), mirrored columns and search terms; returns the stored item.
pub(super) fn refresh(db: &Connection, id: &str) -> Result<Value, AppStorageError> {
    let (rowid, payload, group): (i64, String, Option<String>) = db
        .prepare_cached("SELECT rowid,payload,group_id FROM browser_library WHERE id=?1")
        .and_then(|mut s| {
            s.query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()
        })
        .map_err(sql)?
        .ok_or_else(|| failure(AppStorageCode::LibraryItemNotFound, "Saved item not found."))?;
    let mut item = parse(&payload)?;
    let tags: Vec<String> = db
        .prepare_cached("SELECT g.name FROM browser_library_item_tag t JOIN browser_library_tag g ON g.norm=t.norm WHERE t.item_id=?1 ORDER BY t.norm")
        .and_then(|mut s| s.query_map([id], |r| r.get(0))?.collect())
        .map_err(sql)?;
    let group_name: Option<String> = match &group {
        Some(group) => db
            .prepare_cached("SELECT name FROM browser_library_group WHERE id=?1")
            .and_then(|mut s| s.query_row([group], |r| r.get(0)).optional())
            .map_err(sql)?,
        None => None,
    };
    item["group"] = json!(group);
    item["tags"] = json!(tags);
    let site = site(&item);
    if item["kind"] == "bookmark" {
        item["site"] = json!(site);
        match &group_name {
            Some(name) => item["folder"] = json!(name),
            None => drop(item.as_object_mut().and_then(|o| o.remove("folder"))),
        }
    }
    let title = item["title"].as_str().unwrap_or_default().to_owned();
    db.prepare_cached(
        "UPDATE browser_library SET payload=?2,title=?3,site=?4,title_key=?5 WHERE id=?1",
    )
    .and_then(|mut s| s.execute(params![id, item.to_string(), title, site, key(&title)]))
    .map_err(sql)?;
    let document_text = if item["kind"] == "doc" {
        let head = super::super::documents::head(db, id)?;
        butler_runtime::documents::parse(head["body"].as_str().unwrap_or_default()).text
    } else {
        String::new()
    };
    let block_text = super::blocks::text(&item["block"]);
    let terms = ["title", "autoTitle", "text", "url"]
        .iter()
        .filter_map(|field| item[*field].as_str())
        .chain([document_text.as_str(), block_text.as_str()])
        .chain(tags.iter().map(String::as_str))
        .chain(group_name.as_deref())
        .collect::<Vec<_>>()
        .join(" ");
    db.prepare_cached("DELETE FROM browser_library_fts WHERE rowid=?1")
        .and_then(|mut s| s.execute([rowid]))
        .map_err(sql)?;
    db.prepare_cached("INSERT INTO browser_library_fts(rowid,terms) VALUES(?1,?2)")
        .and_then(|mut s| s.execute(params![rowid, analyze_search_field(&terms)]))
        .map_err(sql)?;
    Ok(item)
}
/// Refreshes every item in `ids`.
pub(super) fn refresh_all(db: &Connection, ids: &[String]) -> Result<Vec<Value>, AppStorageError> {
    ids.iter().map(|id| refresh(db, id)).collect()
}
