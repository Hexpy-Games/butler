//! Per-operation Lance connections with explicit small process-local cache budgets.

use std::{path::Path, sync::Arc};

use lance::session::Session;
use lancedb::{Table, connection::Connection};

// Session capacities are weighted bytes, not entry counts. The separate table
// index cache is a count of entries. No connection/table survives an operation.
const INDEX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const METADATA_CACHE_BYTES: usize = 8 * 1024 * 1024;
const TABLE_INDEX_CACHE_ENTRIES: u32 = 16;

pub(super) async fn connect(uri: &Path) -> lancedb::Result<Connection> {
    let uri = uri.to_str().ok_or_else(|| lancedb::Error::InvalidInput {
        message: "Lance URI is not UTF-8".to_owned(),
    })?;
    let session = Arc::new(Session::new(
        INDEX_CACHE_BYTES,
        METADATA_CACHE_BYTES,
        Arc::new(Default::default()),
    ));
    lancedb::connect(uri).session(session).execute().await
}

pub(super) async fn open(connection: &Connection, name: &str) -> lancedb::Result<Table> {
    connection
        .open_table(name)
        .index_cache_size(TABLE_INDEX_CACHE_ENTRIES)
        .execute()
        .await
}
