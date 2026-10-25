//! Frozen answer blocks resolved exclusively from the assistant's durable spec.
use super::super::storage::AppStorageCode;
use super::{AppStorageError, item, records};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn invalid() -> AppStorageError {
    item::failure(
        AppStorageCode::InvalidLibraryRequest,
        "Choose an assistant answer block.",
    )
}

pub(super) fn get(db: &Connection, id: &str) -> Result<Value, AppStorageError> {
    let payload: String = db
        .query_row(
            "SELECT payload FROM browser_library WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(item::sql)?
        .ok_or_else(|| {
            item::failure(AppStorageCode::LibraryItemNotFound, "Saved item not found.")
        })?;
    item::parse(&payload)
}

pub(super) fn save(db: &Connection, message: &str, path: &str) -> Result<Value, AppStorageError> {
    let (session, stored): (String, String) = db.query_row(
        "SELECT chat_id,blocks_json FROM messages WHERE id=?1 AND role='assistant' AND blocks_json IS NOT NULL",
        [message], |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(item::sql)?.ok_or_else(invalid)?;
    let sets: Value = item::parse(&stored)?;
    let block = extract(&sets, path).ok_or_else(invalid)?;
    let id = format!(
        "block-{:x}",
        Sha256::digest(format!("{message}\0{path}").as_bytes())
    );
    let prior = db
        .query_row(
            "SELECT payload FROM browser_library WHERE id=?1",
            [&id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(item::sql)?;
    if let Some(prior) = prior {
        return item::parse(&prior);
    }
    let mut origin = json!({"session":session,"message":message,"path":path});
    if let Some(id) = block.get("id") {
        origin["id"] = id.clone();
    }
    let strings = text(block);
    let title = block["title"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "{} · {}",
                block["type"].as_str().unwrap_or_default(),
                strings.chars().take(60).collect::<String>()
            )
        });
    let mut site = None;
    butler_runtime::capabilities::answer_blocks::walk(block, &mut |value| {
        if site.is_none() {
            site = value["source"]
                .as_str()
                .and_then(|s| url::Url::parse(s).ok())
                .and_then(|url| url.host_str().map(str::to_owned));
        }
    });
    records::save(
        db,
        &json!({"id":id,"kind":"scrap","block":{"v":2,"blocks":[block]},
        "origin":origin,"capturedAt":item::now(),"title":title,"site":site,"url":""}),
    )
}

/// Canonical paths address the combined top-level blocks of the stored sets.
fn extract<'a>(sets: &'a Value, path: &str) -> Option<&'a Value> {
    let parts: Vec<_> = path.strip_prefix('/')?.split('/').collect();
    let ["blocks", top, rest @ ..] = parts.as_slice() else {
        return None;
    };
    let index = |s: &str| s.parse::<usize>().ok().filter(|n| n.to_string() == s);
    let block = sets
        .as_array()?
        .iter()
        .flat_map(|set| set["spec"]["blocks"].as_array().into_iter().flatten())
        .nth(index(top)?)?;
    match rest {
        [] => Some(block),
        ["blocks", child] if matches!(block["type"].as_str(), Some("columns" | "group")) => {
            block["blocks"].get(index(child)?)
        }
        ["tabs", tab, "blocks", child] if block["type"] == "tabs" => {
            block["tabs"].get(index(tab)?)?["blocks"].get(index(child)?)
        }
        _ => None,
    }
}

/// Searchable content excludes structural identities, asset ids and URL values.
pub(super) fn text(value: &Value) -> String {
    let mut out = Vec::new();
    strings(value, &mut out);
    out.join(" ")
}
fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) if !s.starts_with("img_") && url::Url::parse(s).is_err() => {
            out.push(s.clone());
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                if !matches!(key.as_str(), "id" | "img" | "image_url") {
                    strings(value, out);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                strings(item, out);
            }
        }
        _ => {}
    }
}

/// Freeze one embed resolved from the document's committed canonical body.
pub(super) fn save_document(
    db: &Connection,
    id: &str,
    index: usize,
) -> Result<Value, AppStorageError> {
    let doc = super::super::documents::head(db, id)?;
    let markdown = butler_runtime::documents::parse(doc["body"].as_str().unwrap_or_default());
    let fence = markdown.fences.get(index).ok_or_else(invalid)?;
    let spec: Value = serde_json::from_str(&fence.content).map_err(|_| invalid())?;
    let digest = format!("{:x}", Sha256::digest(fence.content.as_bytes()));
    let title = doc["title"].as_str().unwrap_or_default();
    records::save(
        db,
        &json!({"id":format!("block-{digest}"),"kind":"scrap","title":title,"block":spec,
        "origin":{"document":id,"session":doc["chat_id"],"message":doc["message_id"],"path":format!("/fences/{index}")},
        "capturedAt":item::now(),"url":""}),
    )
}
