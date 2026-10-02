//! Keep read connections open so data_version observes commits during idle.
use butler_e2e::e2e::HarnessError;
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

pub(super) struct Watch(Vec<(Connection, u64)>);
impl Watch {
    pub(super) fn open(data: &Path) -> Result<Self, HarnessError> {
        let mut databases = Vec::new();
        for name in [
            "app-server/butler-client.sqlite",
            "agent-runtime/btcc.sqlite",
        ] {
            let path = data.join(name);
            assert!(path.is_file(), "missing idle database: {}", path.display());
            let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let version = data_version(&db);
            databases.push((db, version));
        }
        Ok(Self(databases))
    }
    pub(super) fn assert_unchanged(&mut self) {
        for (db, before) in &mut self.0 {
            let after = data_version(db);
            eprintln!(
                "PERF-IDLE database={} writes={}",
                db.path().unwrap(),
                after - *before
            );
            assert_eq!(after, *before, "database commits during idle");
            *before = after;
        }
    }
}
fn data_version(db: &Connection) -> u64 {
    db.query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap()
}
