//! Attachment rows and changed-file projection for an already-loaded page.
use super::*;

pub(super) fn attachments(
    connection: &Connection,
    ids: &[String],
) -> Result<HashMap<String, Vec<MessageFileRef>>, AppStorageError> {
    let mut result = HashMap::new();
    let mut statement = connection.prepare_cached("SELECT f.id,f.kind,f.mime_type,f.safe_name,f.size_bytes,f.sha256,f.created_at,f.source_label,f.deliverable,f.title \
        FROM message_attachments a JOIN message_files f ON f.id=a.file_id WHERE a.message_id=?1 ORDER BY a.position")
        .map_err(AppStorageError::sqlite)?;
    for id in ids {
        let rows = statement
            .query_map([id], |row| {
                file_ref_from_values(
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    (row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?),
                )
            })
            .map_err(AppStorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppStorageError::sqlite)?;
        result.insert(id.clone(), rows);
    }
    Ok(result)
}

pub(in crate::gateway::application) fn message_file_ref(
    row: &super::super::AppMessageFileSnapshot,
) -> Result<MessageFileRef, AppStorageError> {
    file_ref_from_values(
        row.id.clone(),
        row.kind.clone(),
        row.mime_type.clone(),
        row.safe_name.clone(),
        row.size_bytes,
        row.sha256.clone(),
        (
            row.created_at.clone(),
            row.source_label.clone(),
            row.deliverable,
            row.title.clone(),
        ),
    )
    .map_err(AppStorageError::sqlite)
}

pub(super) fn file_ref_from_values(
    id: String,
    kind: String,
    mime_type: String,
    safe_name: String,
    size_bytes: u64,
    sha256: String,
    metadata: (String, Option<String>, bool, Option<String>),
) -> rusqlite::Result<MessageFileRef> {
    let (created_at, source_label, deliverable, title) = metadata;
    Ok(MessageFileRef {
        title,
        url: format!("/message-files/{}", encode_component(&id)),
        file_id: id,
        kind: parse_sql_enum(kind)?,
        mime_type,
        safe_name,
        size_bytes,
        sha256,
        created_at,
        source_label,
        deliverable,
    })
}

pub(super) fn changed_files(
    connection: &Connection,
    ids: &[String],
) -> Result<HashMap<String, Vec<ChangedFileDetail>>, AppStorageError> {
    let mut result = HashMap::new();
    let mut statement = connection
        .prepare_cached(
            "SELECT safe_path_label,detail_json FROM message_changed_files \
        WHERE message_id=?1 ORDER BY position",
        )
        .map_err(AppStorageError::sqlite)?;
    for id in ids {
        let rows = statement
            .query_map([id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(AppStorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppStorageError::sqlite)?;
        let values = rows
            .into_iter()
            .filter_map(|(path, json)| json.map(|json| (path, json)))
            .map(|(path, json)| {
                let mut detail =
                    serde_json::from_str::<ChangedFileDetail>(&json).map_err(|error| {
                        AppStorageError::new(
                            AppStorageCode::AppProjectionJsonInvalid,
                            error.to_string(),
                        )
                        .with_source(error)
                    })?;
                detail.path = path;
                Ok(detail)
            })
            .collect::<Result<Vec<_>, AppStorageError>>()?;
        result.insert(id.clone(), values);
    }
    Ok(result)
}

/// Pair only the files already loaded for this message; stored diffs stay intact.
pub(super) fn pair_changes(
    changes: Vec<ChangedFileDetail>,
    files: &[MessageFileRef],
) -> Vec<ChangedFileDetail> {
    changes
        .into_iter()
        .filter_map(|mut change| {
            let file = files
                .iter()
                .find(|f| f.source_label.as_deref() == Some(&change.path));
            if file.is_some_and(|f| f.deliverable) {
                return None;
            }
            change.file_id = file.map(|f| f.file_id.clone());
            Some(change)
        })
        .collect()
}
