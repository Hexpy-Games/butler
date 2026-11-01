//! Keep read connections open so data_version observes commits during idle.
use butler_e2e::e2e::HarnessError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

const QUIET_PERIOD: Duration = Duration::from_millis(100);
const QUIET_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct Watch {
    databases: Vec<(butler_platform::sqlite::Connection, u64)>,
    data: PathBuf,
    before: BTreeMap<PathBuf, (u64, SystemTime)>,
    changes: Arc<Mutex<Vec<String>>>,
    barrier: PathBuf,
    barrier_removed: Arc<tokio::sync::Notify>,
    watcher: RecommendedWatcher,
}
impl Watch {
    pub(crate) async fn open_after_quiet(data: &Path) -> Result<Self, HarnessError> {
        let mut watch = Self::open(data)?;
        watch.wait_until_quiet().await?;
        Ok(watch)
    }

    pub(crate) async fn open_after_quiet_with_paths(
        data: &Path,
        paths: &[&Path],
    ) -> Result<Self, HarnessError> {
        let mut watch = Self::open(data)?;
        for path in paths {
            watch
                .watcher
                .watch(path, RecursiveMode::Recursive)
                .map_err(std::io::Error::other)?;
        }
        watch.wait_until_quiet().await?;
        Ok(watch)
    }

    pub(crate) fn open(data: &Path) -> Result<Self, HarnessError> {
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
        let barrier = data.join(format!(".idle-watch-barrier-{}", uuid::Uuid::new_v4()));
        let marker = barrier.clone();
        let barrier_removed = Arc::new(tokio::sync::Notify::new());
        let removed = barrier_removed.clone();
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
                            // NTFS commits a directory's own timestamp after the
                            // write that caused it and reports that as a bare
                            // Modify of the directory, seconds later. Entries
                            // created, removed or rewritten are reported on
                            // their own paths, so only this echo is ignored.
                            if butler_platform::change_notifications::DIRECTORY_TIMESTAMP_ECHO
                                && matches!(event.kind, notify::EventKind::Modify(_))
                                && path.is_dir()
                            {
                                continue;
                            }
                            if path == marker {
                                if event.kind.is_remove() {
                                    // Removal is ordered after all pre-barrier events, even
                                    // when FSEvents delivers them after an empty quiet period.
                                    changes.clear();
                                    removed.notify_one();
                                }
                                continue;
                            }
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
            barrier,
            barrier_removed,
            watcher,
        })
    }

    async fn wait_until_quiet(&mut self) -> Result<(), HarnessError> {
        let deadline = std::time::Instant::now() + QUIET_TIMEOUT;
        loop {
            if std::time::Instant::now() >= deadline {
                return Err(HarnessError(
                    "timed out waiting for a quiet idle-watch baseline".into(),
                ));
            }
            tokio::time::sleep(QUIET_PERIOD).await;
            let changed = {
                let mut changes = self.changes.lock().unwrap();
                let changed = !changes.is_empty();
                changes.clear();
                changed
            };
            if changed {
                continue;
            }

            self.drain_barrier(deadline).await?;
            let before = snapshot(&self.data)?;
            let versions: Vec<_> = self
                .databases
                .iter_mut()
                .map(|(db, _)| data_version(db))
                .collect();
            let changes = self.changes.lock().unwrap();
            if !changes.is_empty() {
                continue;
            }
            if std::time::Instant::now() >= deadline {
                return Err(HarnessError(
                    "timed out waiting for a quiet idle-watch baseline".into(),
                ));
            }
            self.before = before;
            for ((_, version), next) in self.databases.iter_mut().zip(versions) {
                *version = next;
            }
            return Ok(());
        }
    }

    async fn drain_barrier(&self, deadline: std::time::Instant) -> Result<(), HarnessError> {
        // create_new prevents overwriting any existing file. Remove it before
        // waiting, so neither metadata baseline can contain the harness marker.
        drop(fs::File::create_new(&self.barrier)?);
        fs::remove_file(&self.barrier)?;
        tokio::time::timeout_at(deadline.into(), self.barrier_removed.notified())
            .await
            .map_err(|_| HarnessError("timed out waiting for idle-watch barrier removal".into()))?;
        Ok(())
    }

    pub(crate) fn assert_subtree_unchanged(&self, relative: &Path) -> Result<(), HarnessError> {
        let changes = self.changes.lock().unwrap();
        let relevant = changes
            .iter()
            .filter(|p| Path::new(p).starts_with(relative) || p.starts_with("watch failed:"))
            .collect::<Vec<_>>();
        assert_eq!(
            relevant,
            Vec::<&String>::new(),
            "filesystem mutations under {}",
            relative.display()
        );
        let root = self.data.join(relative);
        let before = self
            .before
            .iter()
            .filter(|(p, _)| p.starts_with(&root))
            .map(|(p, v)| (p.clone(), *v))
            .collect::<BTreeMap<_, _>>();
        let after = snapshot(&root)?;
        assert_eq!(before, after, "idle subtree metadata changed");
        Ok(())
    }

    pub(crate) fn assert_unchanged(&mut self) {
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
    let version = db
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap();
    butler_platform::sqlite::sync_wal_index(db).unwrap();
    version
}
