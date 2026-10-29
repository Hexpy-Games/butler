use super::{records::*, *};
use butler_runtime::documents as markdown;
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn title(input: &Value) -> Result<&str, AppStorageError> {
    input["title"]
        .as_str()
        .filter(|s| (1..=200).contains(&s.chars().count()))
        .ok_or_else(|| invalid("Title must be 1–200 characters."))
}
fn validate(input: &Value) -> Result<(), AppStorageError> {
    if !input["body"].is_string() || body(input).len() > markdown::MAX_BODY_BYTES {
        return Err(invalid("Body must be Markdown of at most 256 KB."));
    }
    if !matches!(input["author"].as_str(), Some("user" | "butler")) {
        return Err(invalid("Author must be user or butler."));
    }
    Ok(())
}
fn store_body(db: &Connection, body: &str) -> Result<String, AppStorageError> {
    let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let parsed = markdown::parse(body);
    for id in &parsed.images {
        if db
            .query_row("SELECT 1 FROM app_assets WHERE id=?1", [id], |_| Ok(()))
            .optional()
            .map_err(AppStorageError::sqlite)?
            .is_none()
        {
            return Err(invalid("An embedded image does not exist."));
        }
    }
    db.execute(
        "INSERT OR IGNORE INTO document_bodies VALUES(?1,?2)",
        params![hash, body],
    )
    .map_err(AppStorageError::sqlite)?;
    for id in parsed.images {
        db.execute(
            "INSERT OR IGNORE INTO app_asset_refs VALUES(?1,'document_body',?2)",
            params![id, hash],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    Ok(hash)
}
pub(super) fn create(
    db: &Connection,
    input: &Value,
    subscribers: &events::EventSubscribers,
) -> Result<Value, AppStorageError> {
    validate(input)?;
    let title = title(input)?;
    let id = format!("doc_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
    let now = now();
    let hash = store_body(db, body(input))?;
    db.execute(
        "INSERT INTO documents VALUES(?1,?2,?3,?4,1,?5,?5)",
        params![
            id,
            title,
            input["chat_id"].as_str(),
            input["message_id"].as_str(),
            now
        ],
    )
    .map_err(AppStorageError::sqlite)?;
    db.execute(
        "INSERT INTO document_revisions VALUES(?1,1,?2,?3,?4,?4)",
        params![id, hash, input["author"].as_str(), now],
    )
    .map_err(AppStorageError::sqlite)?;
    delivery(db, &id, input)?;
    finish(db, &id, "", subscribers)
}
pub(super) fn save(
    db: &Connection,
    id: &str,
    input: &Value,
    restore: bool,
    subscribers: &events::EventSubscribers,
) -> Result<Value, AppStorageError> {
    validate(input)?;
    let expected = positive(input, "expected_rev")?;
    let old = head(db, id)?;
    if old["rev"] != expected {
        return Ok(json!({"code":"revision_conflict","rev":old["rev"]}));
    }
    let title = if input.get("title").is_some() {
        title(input)?
    } else {
        old["title"].as_str().unwrap_or_default()
    };
    let now = now();
    let coalesce = !restore && coalesces(db, id, &old, input, &now)?;
    let rev = if coalesce {
        expected
    } else {
        expected
            .checked_add(1)
            .ok_or_else(|| invalid("Revision limit exceeded."))?
    };
    let old_hash: String = db
        .query_row(
            "SELECT sha256 FROM document_revisions WHERE document_id=?1 AND rev=?2",
            params![id, expected],
            |r| r.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    let hash = store_body(db, body(input))?;
    db.execute(
        "UPDATE documents SET title=?2,head_rev=?3,updated_at=?4 WHERE id=?1 AND head_rev=?5",
        params![id, title, rev, now, expected],
    )
    .map_err(AppStorageError::sqlite)?;
    db.execute("INSERT INTO document_revisions VALUES(?1,?2,?3,?4,?5,?5) ON CONFLICT(document_id,rev) DO UPDATE SET sha256=excluded.sha256,updated_at=excluded.updated_at", params![id,rev,hash,input["author"].as_str(),now]).map_err(AppStorageError::sqlite)?;
    prune(db, &old_hash)?;
    delivery(db, id, input)?;
    finish(db, id, body(&old), subscribers)
}
fn coalesces(
    db: &Connection,
    id: &str,
    old: &Value,
    input: &Value,
    now: &str,
) -> Result<bool, AppStorageError> {
    if old["author"] != "user" || input["author"] != "user" {
        return Ok(false);
    }
    let seen = db
        .query_row(
            "SELECT 1 FROM document_seen WHERE document_id=?1 AND rev>=?2 LIMIT 1",
            params![id, old["rev"].as_i64()],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some();
    if seen {
        return Ok(false);
    }
    let parse = |s| chrono::DateTime::parse_from_rfc3339(s).ok();
    Ok(parse(old["updated_at"].as_str().unwrap_or_default())
        .zip(parse(now))
        .is_some_and(|(old, now)| {
            let age = now.signed_duration_since(old);
            age >= chrono::Duration::zero() && age <= chrono::Duration::seconds(120)
        }))
}
fn finish(
    db: &Connection,
    id: &str,
    previous: &str,
    subscribers: &events::EventSubscribers,
) -> Result<Value, AppStorageError> {
    let result = head(db, id)?;
    let plain = markdown::parse(body(&result)).text;
    super::super::library::editable_document(
        db,
        &json!({"id":id,"kind":"doc","title":result["title"],"url":format!("/documents/{id}"),"session":result["chat_id"],"message":result["message_id"],"rev":result["rev"],"author":result["author"],"updatedAt":result["updated_at"],"capturedAt":result["created_at"],"excerpt":plain.chars().take(200).collect::<String>()}),
    )?;
    let payload = json!({"id":id,"rev":result["rev"],"author":result["author"],"changed":markdown::changed(previous,body(&result))});
    events::append(
        db,
        subscribers,
        "document.updated",
        None,
        payload.as_object().cloned().unwrap_or_default(),
        result["updated_at"].as_str().unwrap_or_default(),
    )?;
    Ok(result)
}
