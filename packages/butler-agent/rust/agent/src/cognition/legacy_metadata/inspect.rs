use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use super::{CognitionResult, ensure_data_authority, metadata_error};

#[derive(Serialize)]
pub(crate) struct LegacyMemoryChunkWithRefs {
    pub memory_chunk_id: String,
    pub schema_version: String,
    pub status: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub summary: String,
    pub text_ref: Option<String>,
    pub text_hash: Option<String>,
    pub privacy_class: String,
    pub freshness_class: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
    pub consolidated_at: Option<String>,
    pub consolidation_run_id: Option<String>,
    pub superseded_by: Option<String>,
    pub origins: Vec<LegacyMemoryOriginRef>,
    pub box_refs: Vec<LegacyMemoryBoxRef>,
    pub feedback_refs: Vec<LegacyMemoryFeedbackRef>,
    pub graph_refs: Vec<LegacyMemoryGraphRef>,
    pub vector_refs: Vec<LegacyMemoryVectorRef>,
}

#[derive(Serialize)]
pub(crate) struct LegacyMemoryOriginRef {
    pub ref_type: String,
    pub ref_id: String,
}

#[derive(Serialize)]
pub(crate) struct LegacyMemoryBoxRef {
    pub box_item_id: String,
    pub relation: String,
}

#[derive(Serialize)]
pub(crate) struct LegacyMemoryFeedbackRef {
    pub feedback_id: String,
    pub relation: String,
}

#[derive(Serialize)]
pub(crate) struct LegacyMemoryGraphRef {
    pub graph_ref_type: String,
    pub graph_ref_id: String,
    pub relation: String,
}

#[derive(Serialize)]
pub(crate) struct LegacyMemoryVectorRef {
    pub vector_store: String,
    pub vector_table: String,
    pub vector_row_id: String,
    pub embedding_model: String,
    pub embedding_dimension: Option<i64>,
    pub indexed_at: String,
}

pub(super) fn read_chunk_with_refs(
    data_root: &Path,
    path: &Path,
    memory_chunk_id: &str,
) -> CognitionResult<Option<LegacyMemoryChunkWithRefs>> {
    if !path.try_exists().map_err(|_| metadata_error())? {
        return Ok(None);
    }
    ensure_data_authority(data_root, &[path])?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| metadata_error())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| metadata_error())?;
    let chunk = db
        .query_row(
            "SELECT memory_chunk_id,schema_version,status,scope,project_id,summary,text_ref,text_hash,privacy_class,freshness_class,source,created_at,updated_at,consolidated_at,consolidation_run_id,superseded_by FROM memory_chunks WHERE memory_chunk_id=?1",
            [memory_chunk_id],
            |row| {
                Ok(LegacyMemoryChunkWithRefs {
                    memory_chunk_id: row.get(0)?,
                    schema_version: row.get(1)?,
                    status: row.get(2)?,
                    scope: row.get(3)?,
                    project_id: row.get(4)?,
                    summary: row.get(5)?,
                    text_ref: row.get(6)?,
                    text_hash: row.get(7)?,
                    privacy_class: row.get(8)?,
                    freshness_class: row.get(9)?,
                    source: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    consolidated_at: row.get(13)?,
                    consolidation_run_id: row.get(14)?,
                    superseded_by: row.get(15)?,
                    origins: Vec::new(),
                    box_refs: Vec::new(),
                    feedback_refs: Vec::new(),
                    graph_refs: Vec::new(),
                    vector_refs: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(|_| metadata_error())?;
    let Some(mut chunk) = chunk else {
        return Ok(None);
    };
    let mut statement = db
        .prepare("SELECT ref_type,ref_id FROM memory_chunk_origins WHERE memory_chunk_id=?1 ORDER BY ref_type,ref_id")
        .map_err(|_| metadata_error())?;
    chunk.origins = statement
        .query_map([memory_chunk_id], |row| {
            Ok(LegacyMemoryOriginRef {
                ref_type: row.get(0)?,
                ref_id: row.get(1)?,
            })
        })
        .map_err(|_| metadata_error())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| metadata_error())?;
    let mut statement = db
        .prepare("SELECT box_item_id,relation FROM memory_chunk_box_refs WHERE memory_chunk_id=?1 ORDER BY box_item_id,relation")
        .map_err(|_| metadata_error())?;
    chunk.box_refs = statement
        .query_map([memory_chunk_id], |row| {
            Ok(LegacyMemoryBoxRef {
                box_item_id: row.get(0)?,
                relation: row.get(1)?,
            })
        })
        .map_err(|_| metadata_error())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| metadata_error())?;
    let mut statement = db
        .prepare("SELECT feedback_id,relation FROM memory_chunk_feedback_refs WHERE memory_chunk_id=?1 ORDER BY feedback_id,relation")
        .map_err(|_| metadata_error())?;
    chunk.feedback_refs = statement
        .query_map([memory_chunk_id], |row| {
            Ok(LegacyMemoryFeedbackRef {
                feedback_id: row.get(0)?,
                relation: row.get(1)?,
            })
        })
        .map_err(|_| metadata_error())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| metadata_error())?;
    let mut statement = db
        .prepare("SELECT graph_ref_type,graph_ref_id,relation FROM memory_chunk_graph_refs WHERE memory_chunk_id=?1 ORDER BY graph_ref_type,graph_ref_id,relation")
        .map_err(|_| metadata_error())?;
    chunk.graph_refs = statement
        .query_map([memory_chunk_id], |row| {
            Ok(LegacyMemoryGraphRef {
                graph_ref_type: row.get(0)?,
                graph_ref_id: row.get(1)?,
                relation: row.get(2)?,
            })
        })
        .map_err(|_| metadata_error())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| metadata_error())?;
    let mut statement = db
        .prepare("SELECT vector_store,vector_table,vector_row_id,embedding_model,embedding_dimension,indexed_at FROM memory_chunk_vector_refs WHERE memory_chunk_id=?1 ORDER BY vector_store,vector_table,vector_row_id")
        .map_err(|_| metadata_error())?;
    chunk.vector_refs = statement
        .query_map([memory_chunk_id], |row| {
            Ok(LegacyMemoryVectorRef {
                vector_store: row.get(0)?,
                vector_table: row.get(1)?,
                vector_row_id: row.get(2)?,
                embedding_model: row.get(3)?,
                embedding_dimension: row.get(4)?,
                indexed_at: row.get(5)?,
            })
        })
        .map_err(|_| metadata_error())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| metadata_error())?;
    Ok(Some(chunk))
}
