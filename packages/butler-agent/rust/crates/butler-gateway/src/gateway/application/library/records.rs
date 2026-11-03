//! Derived Library rows; callers own the enclosing App transaction.
use super::super::read_model;
use super::AppStorageError;
use super::item::{self, sql};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

/// Import identity uses the Library's existing normalized folder identity.
pub(in crate::gateway::application) fn bookmark_in_folder(
    db: &Connection,
    url: &str,
    folder: &str,
) -> Result<bool, AppStorageError> {
    let group = if folder.trim().is_empty() {
        None
    } else {
        let Some(group) = item::find_group(db, "bookmark", folder)? else {
            return Ok(false);
        };
        Some(group)
    };
    db.query_row(
        "SELECT 1 FROM browser_library WHERE kind='bookmark' AND url=?1 AND group_id IS ?2 LIMIT 1",
        params![url, group],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(sql)
}

/// Inserts or replaces a saved item and returns it as stored.
///
/// Saving an existing item again keeps its group, tags and user title unless
/// the item names them: `group` (an id or null), `tags`, or for a bookmark
/// `folder` (a group name; empty or null for none). The saved `title` is the
/// item's own title: after a rename it becomes the `autoTitle`.
pub(in crate::gateway::application) fn save(
    db: &Connection,
    item: &Value,
) -> Result<Value, AppStorageError> {
    let mut item = item.clone();
    picture_asset(db, &mut item)?;
    if let Some(time) = item["capturedAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    {
        item["capturedAt"] = json!(
            time.to_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
    }
    let id = item["id"].as_str().unwrap_or_default().to_owned();
    let kind = item["kind"].as_str().unwrap_or_default().to_owned();
    let prior: Option<(String, Option<String>)> = db
        .query_row(
            "SELECT payload,group_id FROM browser_library WHERE id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    let (prior_item, prior_group) = match prior {
        Some((payload, group)) => (Some(item::parse(&payload)?), group),
        None => (None, None),
    };
    keep_user_title(&mut item, prior_item.as_ref());
    let group = match requested_group(db, &kind, &item)? {
        Some(group) => group,
        None => prior_group,
    };
    let tags = item["tags"].as_array().map(|tags| {
        tags.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    db.execute("INSERT INTO browser_library(id,kind,title,url,payload,created_at,group_id) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,payload=excluded.payload,created_at=excluded.created_at,group_id=excluded.group_id",
        params![id,kind,item["title"].as_str(),item["url"].as_str(),item.to_string(),item["capturedAt"].as_str(),group]).map_err(sql)?;
    if let Some(tags) = tags {
        item::replace_tags(db, &id, &tags)?;
    }
    item::refresh(db, &id)
}
/// Validate the original picture in the save transaction and expose its signing key.
fn picture_asset(db: &Connection, item: &mut Value) -> Result<(), AppStorageError> {
    if item["kind"] != "scrap" || item.get("asset").is_none() {
        return Ok(());
    }
    let asset = item["asset"].as_str().unwrap_or_default();
    let picture = db
        .query_row(
            "SELECT 1 FROM app_assets WHERE id=?1 AND kind IN ('generated','original','collected')",
            [asset],
            |_| Ok(()),
        )
        .optional()
        .map_err(sql)?
        .is_some();
    if !picture {
        return Err(item::failure(
            super::super::storage::AppStorageCode::InvalidLibraryItem,
            "Invalid saved item.",
        ));
    }
    item["img"] = json!(asset);
    Ok(())
}
/// After a rename the user's title stays and the saved title is the new `autoTitle`.
fn keep_user_title(item: &mut Value, prior: Option<&Value>) {
    let Some(object) = item.as_object_mut() else {
        return;
    };
    object.remove("autoTitle");
    let Some(prior) = prior.filter(|prior| prior["autoTitle"].is_string()) else {
        return;
    };
    let saved = object.get("title").cloned().unwrap_or(Value::Null);
    let auto = if saved == prior["title"] {
        prior["autoTitle"].clone()
    } else {
        saved
    };
    object.insert("autoTitle".into(), auto);
    object.insert("title".into(), prior["title"].clone());
}
/// The group the item names, if it names one (`Some(None)` for none).
fn requested_group(
    db: &Connection,
    kind: &str,
    item: &Value,
) -> Result<Option<Option<String>>, AppStorageError> {
    if let Some(group) = item.get("group") {
        let Some(id) = group.as_str() else {
            return Ok(Some(None));
        };
        item::check_group(db, id, kind)?;
        return Ok(Some(Some(id.to_owned())));
    }
    if kind != "bookmark" {
        return Ok(None);
    }
    let Some(folder) = item.get("folder") else {
        return Ok(None);
    };
    let name = folder.as_str().map(str::trim).unwrap_or_default();
    if name.is_empty() {
        return Ok(Some(None));
    }
    Ok(Some(Some(item::ensure_group(db, kind, name)?.0)))
}
pub(in crate::gateway::application) fn document(
    db: &Connection,
    id: &str,
) -> Result<(), AppStorageError> {
    let row=db.query_row("SELECT id,owner_session_id,message_id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at,source_label,deliverable,title,width,height FROM message_files WHERE id=?1",[id],|r|Ok(super::super::AppMessageFileSnapshot {
        id:r.get(0)?,owner_session_id:r.get(1)?,message_id:r.get(2)?,kind:r.get(3)?,mime_type:r.get(4)?,safe_name:r.get(5)?,size_bytes:r.get(6)?,sha256:r.get(7)?,storage_name:r.get(8)?,created_at:r.get(9)?,source_label:r.get(10)?,deliverable:r.get(11)?,title:r.get(12)?,width:r.get(13)?,height:r.get(14)?
    })).map_err(AppStorageError::sqlite)?;
    let file = read_model::message_file_ref(&row)?;
    save(
        db,
        &json!({"id":format!("document-{}",row.id),"kind":"document","title":row.title.as_deref().unwrap_or(&row.safe_name),"url":file.url,"file":file,"session":row.owner_session_id,"capturedAt":row.created_at}),
    )
    .map(drop)
}
pub(in crate::gateway::application) fn output(o: &butler_runtime::outputs::OutputSummary) -> Value {
    json!({"id":format!("output-{}",o.output_id),"output":o.output_id,"kind":"output","title":o.title,"url":format!("/outputs/{}/view",o.output_id),"session":o.session_id,"capturedAt":o.created_at})
}
/// Migration v2: one bookmark group per distinct folder name (case-insensitive),
/// created in name order so positions follow the names. Rows join them when
/// the migration saves them again.
pub(in crate::gateway::application) fn create_folder_groups(
    db: &Connection,
) -> Result<(), AppStorageError> {
    let mut statement = db
        .prepare("SELECT DISTINCT trim(json_extract(payload,'$.folder')) FROM browser_library WHERE kind='bookmark' AND json_type(payload,'$.folder')='text'")
        .map_err(sql)?;
    let mut names = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    names.retain(|name| !name.is_empty());
    names.sort_by_key(|name| (item::key(name), name.clone()));
    for name in names {
        item::ensure_group(db, "bookmark", &name)?;
    }
    Ok(())
}

/// One document identity per chat/source, with newest-first immutable file refs.
pub(in crate::gateway::application) fn deliverable(
    db: &Connection,
    chat: &str,
    key: &str,
    file_id: &str,
    title: Option<&str>,
) -> Result<Value, AppStorageError> {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(format!("{chat}\0{key}").as_bytes()));
    let id = format!("document-{}", &digest[..32]);
    let row = super::super::admission::file(db, file_id)?.ok_or_else(file_not_found)?;
    let file = read_model::message_file_ref(&row)?;
    let prior: Option<String> = db
        .query_row(
            "SELECT payload FROM browser_library WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    let prior = prior.as_deref().map(item::parse).transpose()?;
    let mut revisions = prior
        .as_ref()
        .and_then(|p| p["revisions"].as_array())
        .cloned()
        .unwrap_or_default();
    if revisions
        .first()
        .is_some_and(|r| r["file"]["sha256"] == file.sha256)
    {
        return item::refresh(db, &id);
    }
    revisions.insert(
        0,
        json!({"file":file,"message":row.message_id,"capturedAt":row.created_at}),
    );
    revisions.truncate(20);
    save(
        db,
        &json!({"id":id,"kind":"document","title":title.unwrap_or(&row.safe_name),"url":file.url,
        "file":file,"session":chat,"source":key,"capturedAt":row.created_at,"revisions":revisions}),
    )
}
pub(super) fn promote(db: &Connection, id: &str) -> Result<Value, AppStorageError> {
    let owner: Option<(String, Option<String>)> = db.query_row(
        "SELECT m.chat_id,f.source_label FROM message_files f JOIN messages m ON m.id=f.message_id JOIN chats c ON c.id=m.chat_id WHERE f.id=?1 AND m.role='assistant'",
        [id], |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(sql)?;
    let (chat, source) = owner.ok_or_else(file_not_found)?;
    db.execute("UPDATE message_files SET deliverable=1 WHERE id=?1", [id])
        .map_err(sql)?;
    deliverable(
        db,
        &chat,
        &source.unwrap_or_else(|| format!("file:{id}")),
        id,
        None,
    )
}
fn file_not_found() -> AppStorageError {
    AppStorageError::new(
        super::super::storage::AppStorageCode::LibraryFileNotFound,
        "File not found.",
    )
}

/// Editable document titles are authoritative, with history owned by documents.
pub(in crate::gateway::application) fn editable_document(
    db: &Connection,
    item: &Value,
) -> Result<Value, AppStorageError> {
    let id = item["id"].as_str().unwrap_or_default();
    db.execute("INSERT INTO browser_library(id,kind,title,url,payload,created_at) VALUES(?1,'doc',?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET title=excluded.title,payload=excluded.payload,created_at=excluded.created_at",
        params![id,item["title"].as_str(),item["url"].as_str(),item.to_string(),item["updatedAt"].as_str()]).map_err(sql)?;
    item::refresh(db, id)
}
