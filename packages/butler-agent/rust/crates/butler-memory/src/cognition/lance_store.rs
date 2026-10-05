//! Lance connections with explicit small process-local cache budgets. The
//! connection and table of a generation are opened once and shared by every
//! operation on it: reopening a table costs a manifest read and a fresh
//! metadata cache each time.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
    time::Duration,
};

use lance::session::Session;
use lancedb::{Table, connection::Connection};
use parking_lot::Mutex;

mod portable_file;

// Session capacities are weighted bytes, not entry counts. The separate table
// index cache is a count of entries.
const INDEX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const METADATA_CACHE_BYTES: usize = 8 * 1024 * 1024;
const TABLE_INDEX_CACHE_ENTRIES: u32 = 16;
/// Generations whose table stays open: the serving one and one being built.
const OPEN_TABLES: usize = 2;

pub(super) async fn connect(uri: &Path) -> lancedb::Result<Connection> {
    let uri = uri.to_str().ok_or_else(|| lancedb::Error::InvalidInput {
        message: "Lance URI is not UTF-8".to_owned(),
    })?;
    let registry = Arc::new(Default::default());
    if portable_file_required() {
        portable_file::configure(&registry)?;
    }
    let session = Arc::new(Session::new(
        INDEX_CACHE_BYTES,
        METADATA_CACHE_BYTES,
        registry,
    ));
    lancedb::connect(uri)
        // Another handle (an optimize run, a rebuild) may have written since
        // this table was opened: check the manifest on every read.
        .read_consistency_interval(Duration::ZERO)
        .session(session)
        .execute()
        .await
}

fn portable_file_required() -> bool {
    !butler_platform::secure_fs::TEMPFILE_LONG_PATH_PERSISTENCE
        || matches!(
            std::env::var("BUTLER_E2E_TIER").as_deref(),
            Ok("stub" | "perf")
        ) && std::env::var("BUTLER_E2E_PORTABLE_LANCE").as_deref() == Ok("1")
}

pub(super) async fn open(connection: &Connection, name: &str) -> lancedb::Result<Table> {
    connection
        .open_table(name)
        .index_cache_size(TABLE_INDEX_CACHE_ENTRIES)
        .execute()
        .await
}

/// Tables opened for `shared`, oldest first.
static OPEN: LazyLock<Mutex<Vec<(PathBuf, Table)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// The table `name` under the Lance directory `root`, opened once and then
/// shared. A failed open is not remembered.
pub(super) async fn shared(root: &Path, name: &str) -> lancedb::Result<Table> {
    let key = root.join(name);
    if let Some(table) = OPEN
        .lock()
        .iter()
        .find_map(|(path, table)| (*path == key).then(|| table.clone()))
    {
        return Ok(table);
    }
    let connection = connect(root).await?;
    let table = open(&connection, name).await?;
    let mut open = OPEN.lock();
    if !open.iter().any(|(path, _)| *path == key) {
        open.push((key, table.clone()));
    }
    while open.len() > OPEN_TABLES {
        open.remove(0);
    }
    Ok(table)
}

/// Forgets the shared table of `root`, after an error or when its directory
/// was removed, so the next use opens it afresh.
pub(super) fn forget(root: &Path, name: &str) {
    let key: PathBuf = root.join(name);
    OPEN.lock().retain(|(path, _)| *path != key);
}
