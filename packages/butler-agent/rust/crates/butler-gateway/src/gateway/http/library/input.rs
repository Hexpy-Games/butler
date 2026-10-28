//! Request checks of the Library routes; every failure is a public 400.
use super::HttpError;
use crate::gateway::{AppLibraryChange, AppLibraryQuery};
use serde_json::Value;
use std::collections::HashMap;

/// Items one organize call may change.
const MAX_IDS: usize = 500;
/// Items one agent search returns at most.
const MAX_SEARCH: usize = 50;

fn invalid(message: &str) -> HttpError {
    HttpError::public(400, "invalid_library_request", message)
}
/// One of the Library kinds; listings default to scraps.
pub(super) fn kind(value: Option<&String>) -> Result<String, HttpError> {
    match value.map(String::as_str).unwrap_or("scrap") {
        kind @ ("scrap" | "document" | "doc" | "bookmark" | "output") => Ok(kind.to_owned()),
        _ => Err(invalid(
            "kind must be scrap, document, doc, bookmark or output.",
        )),
    }
}
/// A kind with groups: scrap or bookmark.
pub(super) fn grouped_kind(value: Option<&String>) -> Result<String, HttpError> {
    match value.map(String::as_str) {
        Some(kind @ ("scrap" | "bookmark")) => Ok(kind.to_owned()),
        _ => Err(invalid("kind must be scrap or bookmark.")),
    }
}
/// A trimmed name of `min..=max` characters.
fn name(value: &Value, max: usize, what: &str) -> Result<String, HttpError> {
    let text = value.as_str().map(str::trim).unwrap_or_default();
    let count = text.chars().count();
    if value.is_string() && (1..=max).contains(&count) {
        Ok(text.to_owned())
    } else {
        Err(invalid(&format!("{what} must be 1–{max} characters.")))
    }
}
pub(super) fn group_name(value: &Value) -> Result<String, HttpError> {
    name(value, 100, "Group name")
}
/// A tag name; commas separate tags in the `tags` filter, so none in a name.
pub(super) fn tag(value: &Value) -> Result<String, HttpError> {
    let tag = name(value, 40, "Tag name")?;
    if tag.contains(',') {
        return Err(invalid("Tag names cannot contain commas."));
    }
    Ok(tag)
}
fn tags(value: &Value) -> Result<Vec<String>, HttpError> {
    match value {
        Value::Null => Ok(Vec::new()),
        Value::Array(items) if items.len() <= 100 => items.iter().map(tag).collect(),
        _ => Err(invalid("Tags must be a list of names.")),
    }
}
/// A new group index.
pub(super) fn position(value: &Value) -> Result<Option<usize>, HttpError> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .map(Some)
        .ok_or_else(|| invalid("position must be a non-negative integer."))
}
/// An RFC 3339 bound in the stored capture-time format.
fn time(value: Option<&String>) -> Result<Option<String>, HttpError> {
    value
        .filter(|text| !text.is_empty())
        .map(|text| {
            chrono::DateTime::parse_from_rfc3339(text)
                .map(|time| {
                    time.to_utc()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                })
                .map_err(|_| invalid("since and until must be RFC 3339 times."))
        })
        .transpose()
}
fn filters(args: &HashMap<String, String>, query: &mut AppLibraryQuery) -> Result<(), HttpError> {
    let text = |key: &str| args.get(key).map(|v| v.trim()).filter(|v| !v.is_empty());
    query.search = args.get("q").cloned().unwrap_or_default();
    query.cursor = args.get("cursor").cloned().unwrap_or_default();
    query.group = text("group").map(str::to_owned);
    query.tags = text("tags")
        .map(|tags| {
            tags.split(',')
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    query.site = text("site").map(str::to_owned);
    query.since = time(args.get("since"))?;
    query.until = time(args.get("until"))?;
    query.sort = match text("sort").unwrap_or("new") {
        sort @ ("new" | "old" | "name" | "site") => sort.to_owned(),
        _ => return Err(invalid("sort must be new, old, name or site.")),
    };
    Ok(())
}
pub(super) fn kinds(args: &HashMap<String, String>) -> Result<String, HttpError> {
    let Some(values) = args.get("kinds") else {
        return kind(args.get("kind"));
    };
    let mut result = Vec::new();
    for value in values.split(',').take(6) {
        let value = kind(Some(&value.to_owned()))?;
        if !result.contains(&value) {
            result.push(value);
        }
    }
    if result.is_empty() || values.split(',').count() > 5 {
        return Err(invalid("Choose one to five kinds."));
    }
    Ok(result.join(","))
}
/// `GET /library`: indexed kinds, every filter, pages of 60.
pub(super) fn page(args: &HashMap<String, String>) -> Result<AppLibraryQuery, HttpError> {
    let mut query = AppLibraryQuery {
        kind: Some(kinds(args)?),
        limit: 60,
        ..AppLibraryQuery::default()
    };
    filters(args, &mut query)?;
    Ok(query)
}
/// `GET /library/search`: the agent's search; any kind, group by name.
pub(super) fn search(args: &HashMap<String, String>) -> Result<AppLibraryQuery, HttpError> {
    let mut query = AppLibraryQuery {
        kind: args.get("kind").map(|k| kind(Some(k))).transpose()?,
        group_by_name: true,
        limit: args
            .get("limit")
            .and_then(|limit| limit.parse::<usize>().ok())
            .unwrap_or(20)
            .clamp(1, MAX_SEARCH),
        ..AppLibraryQuery::default()
    };
    filters(args, &mut query)?;
    Ok(query)
}
/// `PATCH /library/items` (group id) or `POST /library/organize` (group name).
pub(super) fn change(value: &Value, by_name: bool) -> Result<AppLibraryChange, HttpError> {
    let mut ids: Vec<String> = Vec::new();
    for id in value["ids"].as_array().into_iter().flatten() {
        let id = id
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or_else(|| invalid("ids must be saved item ids."))?;
        if !ids.iter().any(|known| known == id) {
            ids.push(id.to_owned());
        }
    }
    if ids.is_empty() || ids.len() > MAX_IDS {
        return Err(invalid("ids must list 1–500 saved items."));
    }
    let group = match value.get("group") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(group) if by_name => Some(Some(group_name(group)?)),
        Some(Value::String(id)) if !id.is_empty() => Some(Some(id.clone())),
        Some(_) => return Err(invalid("group must be a group id or null.")),
    };
    let title = match &value["title"] {
        Value::Null => None,
        Value::String(title) if title.chars().count() <= 2000 => Some(title.clone()),
        _ => return Err(invalid("title must be at most 2000 characters.")),
    };
    if title.is_some() && ids.len() != 1 {
        return Err(invalid("A title renames exactly one item."));
    }
    Ok(AppLibraryChange {
        ids,
        group,
        add_tags: tags(&value["addTags"])?,
        remove_tags: tags(&value["removeTags"])?,
        title,
        by_name,
    })
}
/// `POST /library`: a scrap or bookmark, optionally with its group id and tags.
/// Scraps have an optional web origin and exactly one JPEG crop or stored picture.
pub(super) fn item(value: Value) -> Result<Value, HttpError> {
    let organized = (value["group"].is_null()
        || value["group"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && id.len() <= 128))
        && (value.get("tags").is_none()
            || value["tags"].is_array() && tags(&value["tags"]).is_ok());
    if organized && value.get("block").is_none() && value.get("origin").is_none() && valid(&value) {
        Ok(value)
    } else {
        Err(HttpError::public(
            400,
            "invalid_library_item",
            "Invalid saved item.",
        ))
    }
}
fn valid(value: &Value) -> bool {
    let base = value["capturedAt"]
        .as_str()
        .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        && ["id", "title", "url", "capturedAt"]
            .iter()
            .all(|key| value[*key].is_string())
        && value["id"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 128)
        && value["title"].as_str().is_some_and(|s| s.len() <= 2000);
    let web_url = value["url"].as_str().is_some_and(|s| {
        url::Url::parse(s).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.username().is_empty()
                && u.password().is_none()
        })
    });
    base && match value["kind"].as_str() {
        Some("scrap") => {
            value["text"].is_string()
                && (web_url || value["url"] == "")
                && match (value.get("crop"), value.get("asset")) {
                    (Some(crop), None) => crop
                        .as_str()
                        .is_some_and(|s| s.starts_with("data:image/jpeg;base64,")),
                    (None, Some(asset)) => {
                        asset.as_str().is_some_and(super::super::assets::valid_id)
                    }
                    _ => false,
                }
                && valid_snapshot(&value["snapshot"])
        }
        Some("bookmark") => {
            web_url
                && (value["folder"].is_null()
                    || value["folder"].as_str().is_some_and(|s| s.len() <= 200))
        }
        _ => false,
    }
}
/// A scrap's optional HTML copy of the picked part: its size, and the document when it is being saved.
fn valid_snapshot(snapshot: &Value) -> bool {
    snapshot.is_null()
        || (["width", "height"].iter().all(|key| {
            snapshot[*key]
                .as_f64()
                .is_some_and(|n| (1.0..=20_000.0).contains(&n))
        }) && (snapshot["html"].is_null()
            || snapshot["html"].as_str().is_some_and(|html| {
                html.len() <= SNAPSHOT_LIMIT && html.starts_with("<!doctype html>")
            })))
}
/// Bytes of one scrap's HTML copy; larger copies stay image-only on the client.
const SNAPSHOT_LIMIT: usize = 6 * 1024 * 1024;
