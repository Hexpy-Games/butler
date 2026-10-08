//! Keep read connections open so data_version observes commits during idle.
use butler_e2e::e2e::HarnessError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

pub(super) struct Watch {
    databases: Vec<(butler_platform::sqlite::Connection, u64)>,
    data: PathBuf,
    before: BTreeMap<PathBuf, (u64, SystemTime)>,
    changes: Arc<Mutex<Vec<String>>>,
    _watcher: RecommendedWatcher,
}
impl Watch {
    pub(super) fn open(data: &Path) -> Result<Self, HarnessError> {
        let mut databases = Vec::new();
        for name in [
            "app-server/butler-client.sqlite",
            "agent-runtime/btcc.sqlite",
        ] {
            let path = data.join(name);
            assert!(path.is_file(), "missing idle database: {}", path.display());
            let db =
                butler_platform::sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .unwrap();
            let version = data_version(&db);
            databases.push((db, version));
        }
        let changes = Arc::new(Mutex::new(Vec::new()));
        let sink = changes.clone();
        let root = data.to_path_buf();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let mut changes = sink.lock().unwrap();
                match event {
                    Ok(event)
                        if event.kind.is_modify()
                            || event.kind.is_create()
                            || event.kind.is_remove() =>
                    {
                        for path in event.paths {
                            changes.push(
                                path.strip_prefix(&root)
                                    .unwrap_or(&path)
                                    .display()
                                    .to_string(),
                            );
                        }
                    }
                    Err(error) => changes.push(format!("watch failed: {error}")),
                    _ => {}
                }
            })
            .map_err(std::io::Error::other)?;
        watcher
            .watch(data, RecursiveMode::Recursive)
            .map_err(std::io::Error::other)?;
        Ok(Self {
            databases,
            data: data.to_path_buf(),
            before: snapshot(data)?,
            changes,
            _watcher: watcher,
        })
    }
    pub(super) fn assert_unchanged(&mut self) {
        let changes = self.changes.lock().unwrap();
        eprintln!(
            "PERF-IDLE file_write_notifications={} paths={changes:?}",
            changes.len()
        );
        assert!(
            changes.is_empty(),
            "filesystem mutations during idle: {changes:?}"
        );
        assert!(
            snapshot(&self.data).unwrap() == self.before,
            "idle file metadata changed"
        );
        for (db, before) in &mut self.databases {
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

fn snapshot(root: &Path) -> std::io::Result<BTreeMap<PathBuf, (u64, SystemTime)>> {
    let mut files = BTreeMap::new();
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                directories.push(entry.path());
            } else if metadata.is_file() {
                files.insert(entry.path(), (metadata.len(), metadata.modified()?));
            }
        }
    }
    Ok(files)
}
fn data_version(db: &Connection) -> u64 {
    db.query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap()
}
