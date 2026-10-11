//! Filtered, sorted keyset pages over indexed Library columns.
use super::AppStorageError;
use super::item::{self, sql};
use butler_memory::cognition::analyze_search_query;
use rusqlite::Connection;
use rusqlite::types::Value as Sql;
use serde_json::{Value, json};
use std::collections::HashMap;

/// Page size of every Library listing.
const PAGE: usize = 60;

/// One Library listing: every filter narrows the result (AND).
#[derive(Clone, Debug, Default)]
pub struct AppLibraryQuery {
    /// One kind; `None` lists every kind (agent search).
    pub kind: Option<String>,
    pub search: String,
    pub cursor: String,
    /// A group id, `"none"` for ungrouped items, or with `group_by_name` a group name.
    pub group: Option<String>,
    pub group_by_name: bool,
    /// Items must carry every tag.
    pub tags: Vec<String>,
    pub site: Option<String>,
    /// RFC 3339 bounds of the captured time, both inclusive.
    pub since: Option<String>,
    pub until: Option<String>,
    /// `new` (default), `old`, `name` or `site`.
    pub sort: String,
    /// Items per page, at most 60.
    pub limit: usize,
}

/// A page: `{items, next_cursor}`; the cursor is opaque to clients.
pub(super) fn page(db: &Connection, query: &AppLibraryQuery) -> Result<Value, AppStorageError> {
    let rows = rows(db, query)?;
    let (items, next) = rows;
    Ok(json!({"items": items, "next_cursor": next}))
}

/// Matching payloads of one page and the cursor of the next page.
pub(super) fn rows(
    db: &Connection,
    query: &AppLibraryQuery,
) -> Result<(Vec<Value>, Option<String>), AppStorageError> {
    let terms = analyze_search_query(&query.search);
    if !query.search.trim().is_empty() && terms.is_empty() {
        return Ok((Vec::new(), None));
    }
    let limit = query.limit.clamp(1, PAGE);
    let (sql_text, args) = statement(query, &terms, limit);
    let mut statement = db.prepare(&sql_text).map_err(sql)?;
    let mut rows = statement
        .query_map(rusqlite::params_from_iter(args), |r| {
            Ok((
                r.get::<_, String>(0)?,
                [
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ],
            ))
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next = more
        .then(|| rows.last().map(|(_, keys)| cursor(&query.sort, keys)))
        .flatten();
    let items = rows
        .iter()
        .map(|(payload, _)| item::parse(payload))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((items, next))
}

/// The opaque cursor after a row with keys `[created_at, id, title_key, site]`.
fn cursor(sort: &str, [time, id, title, site]: &[String; 4]) -> String {
    match sort {
        "name" => json!([title, id]),
        "site" => json!([site, time, id]),
        _ => json!([time, id]),
    }
    .to_string()
}

/// The SQL of one page and its arguments.
fn statement(query: &AppLibraryQuery, terms: &str, limit: usize) -> (String, Vec<Sql>) {
    let mut sql_text = String::from(if terms.is_empty() {
        "SELECT l.payload,l.created_at,l.id,l.title_key,l.site FROM browser_library l"
    } else {
        "SELECT l.payload,l.created_at,l.id,l.title_key,l.site FROM browser_library_fts JOIN browser_library l ON l.rowid=browser_library_fts.rowid"
    });
    let mut clauses: Vec<&str> = Vec::new();
    let mut args: Vec<Sql> = Vec::new();
    let mut push = |clause: &'static str, values: Vec<String>| {
        clauses.push(clause);
        args.extend(values.into_iter().map(Sql::Text));
    };
    if !terms.is_empty() {
        push("browser_library_fts MATCH ?", vec![terms.to_owned()]);
    }
    if let Some(kind) = &query.kind {
        push("l.kind=?", vec![kind.clone()]);
    }
    match query.group.as_deref() {
        None => {}
        Some("none") if !query.group_by_name => push("l.group_id IS NULL", vec![]),
        Some(name) if query.group_by_name => push(
            "l.group_id IN (SELECT id FROM browser_library_group WHERE name_key=?)",
            vec![item::key(name)],
        ),
        Some(id) => push("l.group_id=?", vec![id.to_owned()]),
    }
    for tag in &query.tags {
        push(
            "l.id IN (SELECT item_id FROM browser_library_item_tag WHERE norm=?)",
            vec![item::key(tag)],
        );
    }
    if let Some(site) = &query.site {
        push("l.site=?", vec![site.clone()]);
    }
    if let Some(since) = &query.since {
        push("l.created_at>=?", vec![since.clone()]);
    }
    if let Some(until) = &query.until {
        push("l.created_at<=?", vec![until.clone()]);
    }
    let after = serde_json::from_str::<Vec<String>>(&query.cursor).unwrap_or_default();
    let order = match (query.sort.as_str(), after.as_slice()) {
        ("old", keys) => {
            if let [time, id] = keys {
                push("(l.created_at,l.id)>(?,?)", vec![time.clone(), id.clone()]);
            }
            "l.created_at,l.id"
        }
        ("name", keys) => {
            if let [title, id] = keys {
                push("(l.title_key,l.id)>(?,?)", vec![title.clone(), id.clone()]);
            }
            "l.title_key,l.id"
        }
        ("site", keys) => {
            if let [site, time, id] = keys {
                push(
                    "(l.site>? OR (l.site=? AND (l.created_at,l.id)<(?,?)))",
                    vec![site.clone(), site.clone(), time.clone(), id.clone()],
                );
            }
            "l.site,l.created_at DESC,l.id DESC"
        }
        (_, keys) => {
            if let [time, id] = keys {
                push("(l.created_at,l.id)<(?,?)", vec![time.clone(), id.clone()]);
            }
            "l.created_at DESC,l.id DESC"
        }
    };
    if !clauses.is_empty() {
        sql_text.push_str(" WHERE ");
        sql_text.push_str(&clauses.join(" AND "));
    }
    sql_text.push_str(&format!(" ORDER BY {order} LIMIT {}", limit + 1));
    (sql_text, args)
}

/// Agent search: compact items (id, kind, title, group name, tags, site,
/// capturedAt, url) across kinds unless one is named.
pub(super) fn search(db: &Connection, query: &AppLibraryQuery) -> Result<Value, AppStorageError> {
    let (items, next) = rows(db, query)?;
    let names = group_names(db, &items)?;
    Ok(json!({
        "items": items.iter().map(|item| compact(item, &names)).collect::<Vec<_>>(),
        "more": next.is_some(),
    }))
}

/// Names of the groups the items are in.
pub(super) fn group_names(
    db: &Connection,
    items: &[Value],
) -> Result<HashMap<String, String>, AppStorageError> {
    let mut names = HashMap::new();
    let mut statement = db
        .prepare_cached("SELECT name FROM browser_library_group WHERE id=?1")
        .map_err(sql)?;
    for id in items.iter().filter_map(|item| item["group"].as_str()) {
        if !names.contains_key(id) {
            let name: String = statement.query_row([id], |r| r.get(0)).map_err(sql)?;
            names.insert(id.to_owned(), name);
        }
    }
    Ok(names)
}

/// The fields the agent needs to name and organize an item.
pub(super) fn compact(item: &Value, groups: &HashMap<String, String>) -> Value {
    let mut out = json!({
        "id": item["id"], "kind": item["kind"], "title": item["title"],
        "group": item["group"].as_str().and_then(|id| groups.get(id)),
        "tags": item["tags"], "capturedAt": item["capturedAt"], "url": item["url"],
    });
    if let Some(site) = item["site"].as_str().filter(|site| !site.is_empty()) {
        out["site"] = json!(site);
    }
    if item["autoTitle"].is_string() {
        out["autoTitle"] = item["autoTitle"].clone();
    }
    out
}
