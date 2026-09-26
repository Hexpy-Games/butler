//! Reads content-complete output from the App-owned operation chunk projection.

use rusqlite::{Connection, params};
use serde::Serialize;

mod chunk;

use super::{AppApplication, GatewayApplicationError, app_error, storage::AppStorageError};
pub(crate) use chunk::OperationOutputChunk;
use chunk::{ChunkOutputRead as AppOutputRead, StoredChunk, VerifiedOutputPage, verify_rows};

const OUTPUT_PAGE_BYTES: usize = 64 * 1024;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct OperationOutputView {
    pub turn_id: String,
    pub request_id: String,
    pub result_id: String,
    pub content: String,
    pub byte_start: u64,
    pub byte_end: u64,
    pub byte_length: u64,
    pub complete: bool,
}

struct OperationOutputQuery {
    turn_id: String,
    request_id: String,
    result_id: String,
    byte_start: u64,
}

impl AppApplication {
    pub(crate) async fn get_operation_output_owned(
        &self,
        turn_id: String,
        request_id: String,
        result_id: String,
        byte_start: u64,
    ) -> Result<Option<OperationOutputView>, GatewayApplicationError> {
        let query = OperationOutputQuery {
            turn_id: turn_id.clone(),
            request_id: request_id.clone(),
            result_id: result_id.clone(),
            byte_start,
        };
        match self
            .storage
            .execute(move |db| read_app_output(db, &query))
            .await
            .map_err(app_error)?
        {
            AppOutputRead::Complete(page) => view_for_page(turn_id, request_id, result_id, page)
                .map(Some)
                .map_err(app_error),
            AppOutputRead::Invalid => Ok(None),
            AppOutputRead::NoRows => {
                let chunks = self
                    .dependencies
                    .subsessions
                    .read_operation_output_chunks(
                        turn_id.clone(),
                        request_id.clone(),
                        result_id.clone(),
                    )
                    .await?;
                match verify_rows(
                    chunks.into_iter().map(|chunk| Ok(StoredChunk::from(chunk))),
                    &result_id,
                    byte_start,
                    OUTPUT_PAGE_BYTES,
                )
                .map_err(app_error)?
                {
                    AppOutputRead::Complete(page) => {
                        view_for_page(turn_id, request_id, result_id, page)
                            .map(Some)
                            .map_err(app_error)
                    }
                    AppOutputRead::Invalid | AppOutputRead::NoRows => Ok(None),
                }
            }
        }
    }
}

fn read_app_output(
    db: &Connection,
    query: &OperationOutputQuery,
) -> Result<AppOutputRead, AppStorageError> {
    match read_chunks(
        db,
        &query.turn_id,
        &query.request_id,
        &query.result_id,
        query.byte_start,
    )? {
        AppOutputRead::NoRows if linked_progress_row(db, query)? => {
            read_aliased_chunks(db, &query.turn_id, &query.result_id, query.byte_start)
        }
        result => Ok(result),
    }
}

fn view_for_page(
    turn_id: String,
    request_id: String,
    result_id: String,
    page: VerifiedOutputPage,
) -> Result<OperationOutputView, AppStorageError> {
    let VerifiedOutputPage {
        byte_start,
        byte_length,
        content,
    } = page;
    let byte_end = byte_start + content.len() as u64;
    let content = match String::from_utf8(content) {
        Ok(content) => content,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    };

    Ok(OperationOutputView {
        turn_id,
        request_id,
        result_id,
        content,
        byte_start,
        byte_end,
        byte_length,
        complete: byte_end >= byte_length,
    })
}

#[cfg(test)]
fn read(
    db: &Connection,
    query: OperationOutputQuery,
) -> Result<Option<OperationOutputView>, AppStorageError> {
    match read_app_output(db, &query)? {
        AppOutputRead::Complete(page) => {
            view_for_page(query.turn_id, query.request_id, query.result_id, page).map(Some)
        }
        AppOutputRead::Invalid | AppOutputRead::NoRows => Ok(None),
    }
}

fn linked_progress_row(
    db: &Connection,
    query: &OperationOutputQuery,
) -> Result<bool, AppStorageError> {
    let Some(progress) = super::progress_view::read(db, &query.turn_id)? else {
        return Ok(false);
    };
    Ok(progress.safe_progress_rows.iter().any(|row| {
        row.get("bridge_phase").and_then(serde_json::Value::as_str) == Some("btcc_operation")
            && row.get("tool_call_id").and_then(serde_json::Value::as_str)
                == Some(query.request_id.as_str())
            && row
                .get("tool_result_id")
                .and_then(serde_json::Value::as_str)
                == Some(query.result_id.as_str())
    }))
}

fn read_chunks(
    db: &Connection,
    turn_id: &str,
    request_id: &str,
    result_id: &str,
    byte_start: u64,
) -> Result<AppOutputRead, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT request_id,result_id,result_sha256,chunk_index,chunk_count,byte_start,byte_end,byte_length,content_base64,content_sha256 \
             FROM app_operation_output_chunks WHERE turn_id=?1 AND request_id=?2 AND result_id=?3 \
             ORDER BY chunk_index",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map(params![turn_id, request_id, result_id], stored_chunk)
        .map_err(AppStorageError::sqlite)?;
    verify_rows(rows, result_id, byte_start, OUTPUT_PAGE_BYTES)
}

fn read_aliased_chunks(
    db: &Connection,
    turn_id: &str,
    result_id: &str,
    byte_start: u64,
) -> Result<AppOutputRead, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT request_id,result_id,result_sha256,chunk_index,chunk_count,byte_start,byte_end,byte_length,content_base64,content_sha256 \
             FROM app_operation_output_chunks WHERE turn_id=?1 AND result_id=?2 \
               AND request_id=(SELECT request_id FROM app_operation_output_chunks \
                 WHERE turn_id=?1 AND result_id=?2 ORDER BY created_at,request_id LIMIT 1) \
             ORDER BY request_id,chunk_index",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map(params![turn_id, result_id], stored_chunk)
        .map_err(AppStorageError::sqlite)?;
    verify_rows(rows, result_id, byte_start, OUTPUT_PAGE_BYTES)
}

fn stored_chunk(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredChunk> {
    Ok(StoredChunk {
        request_id: row.get(0)?,
        result_id: row.get(1)?,
        result_sha256: row.get(2)?,
        chunk_index: row.get(3)?,
        chunk_count: row.get(4)?,
        byte_start: row.get(5)?,
        byte_end: row.get(6)?,
        byte_length: row.get(7)?,
        content_base64: row.get(8)?,
        content_sha256: row.get(9)?,
    })
}
