//! Indexed parent links for usage lineage; no delegation packet decoding.
use super::{SqliteSubsessionRepository, StorageError};
use rusqlite::params_from_iter;

/// A child's parent and optional policy role from the relation index.
type ParentLink = (String, String, Option<String>);

impl SqliteSubsessionRepository {
    /// Indexed append watermark, cheap with retained history.
    pub async fn relation_watermark(&self) -> Result<i64, StorageError> {
        self.storage
            .read(|db| {
                db.query_row(
                    "SELECT COALESCE(MAX(rowid),0) FROM btcc_session_relations",
                    [],
                    |row| row.get(0),
                )
                .map_err(StorageError::sqlite)
            })
            .await
    }

    /// Only relations appended since the last successfully resolved watermark.
    pub async fn parent_links_since(
        &self,
        previous: i64,
        watermark: i64,
    ) -> Result<Vec<ParentLink>, StorageError> {
        self.storage
            .read(move |db| {
                let mut statement = db
                    .prepare(
                        "SELECT child_session_id,parent_session_id,activity_role \
                 FROM btcc_session_relations WHERE rowid > ?1 AND rowid <= ?2 ORDER BY rowid",
                    )
                    .map_err(StorageError::sqlite)?;
                statement
                    .query_map([previous, watermark], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })
                    .map_err(StorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::sqlite)
            })
            .await
    }

    /// Resolve children in bounded indexed batches, including legacy relations.
    pub async fn parent_links(
        &self,
        children: Vec<String>,
    ) -> Result<Vec<ParentLink>, StorageError> {
        self.storage
            .read(move |db| {
                let mut links = Vec::new();
                for chunk in children.chunks(500) {
                    let placeholders = std::iter::repeat_n("?", chunk.len())
                        .collect::<Vec<_>>()
                        .join(",");
                    let sql = format!(
                        "SELECT child_session_id,parent_session_id,activity_role \
                         FROM btcc_session_relations WHERE child_session_id IN ({placeholders})"
                    );
                    let mut statement = db.prepare(&sql).map_err(StorageError::sqlite)?;
                    let rows = statement
                        .query_map(params_from_iter(chunk), |row| {
                            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                        })
                        .map_err(StorageError::sqlite)?;
                    for row in rows {
                        links.push(row.map_err(StorageError::sqlite)?);
                    }
                }
                Ok(links)
            })
            .await
    }
}
