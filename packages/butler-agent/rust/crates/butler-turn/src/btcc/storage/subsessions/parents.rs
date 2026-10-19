//! Indexed parent links for usage lineage; no delegation packet decoding.
use super::{SqliteSubsessionRepository, StorageError};
use rusqlite::params_from_iter;

/// A child's parent and optional policy role from the relation index.
type ParentLink = (String, String, Option<String>);

impl SqliteSubsessionRepository {
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
