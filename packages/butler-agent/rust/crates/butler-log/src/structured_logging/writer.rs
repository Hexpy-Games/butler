mod completion;
mod queue;
mod worker;
use super::encoded::Encoded;
use super::{
    Config, ConfigView, Page, Preset, Query, Record, StorageView, export, query, retention,
    storage::Storage,
};
use parking_lot::{Mutex, RwLock};
use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
};
use tokio::sync::{broadcast, oneshot, watch};

const DEBUG_CAPACITY: usize = 8192;
type Reply<T> = mpsc::SyncSender<io::Result<T>>;
enum Command {
    Deferred(Box<dyn FnOnce() -> Record + Send + Sync>, usize),
    Record(
        Encoded,
        bool,
        usize,
        Option<oneshot::Sender<io::Result<()>>>,
    ),
    Control(Control),
    Dropped,
}
enum Control {
    Flush(Reply<()>),
    #[cfg(feature = "e2e-fixtures")]
    Pause(Mutex<mpsc::Receiver<()>>, Reply<()>),
    Configure(Config, Reply<ConfigView>),
    Clear(Reply<u64>),
    Shutdown(Reply<()>),
    ShutdownBounded(oneshot::Sender<io::Result<()>>),
    #[cfg(feature = "e2e-fixtures")]
    Expire(Reply<()>),
    #[cfg(feature = "e2e-fixtures")]
    SyncCount(Reply<usize>),
    #[cfg(feature = "e2e-fixtures")]
    Prune(Reply<()>),
}
struct Inner {
    tx: mpsc::Sender<Command>,
    storage: Mutex<Storage>,
    config: RwLock<Arc<ConfigView>>,
    queue: queue::Queue,
    pending: AtomicUsize,
    deferred: AtomicUsize,
    dropped: AtomicUsize,
    write_timeouts: AtomicUsize,
    live: broadcast::Sender<Record>,
    changes: watch::Sender<ConfigView>,
    join: Mutex<Option<thread::JoinHandle<io::Result<()>>>>,
}
#[derive(Clone)]
pub struct Logger(Arc<Inner>);
impl Logger {
    pub fn open(data: &Path, config: Config) -> io::Result<Self> {
        Self::open_mode(data, config, true)
    }
    /// A secondary process appends private segments; only the service prunes shared logs.
    pub fn producer(data: &Path, config: Config) -> io::Result<Self> {
        Self::open_mode(data, config, false)
    }
    fn open_mode(data: &Path, config: Config, owner: bool) -> io::Result<Self> {
        if !config.valid() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid log configuration",
            ));
        }
        let storage = if owner {
            Storage::open(data.join(butler_platform::data_paths::LOGS), &config)?
        } else {
            Storage::producer(data.join(butler_platform::data_paths::LOGS), &config)?
        };
        let initial_full = config.level == Preset::Full;
        let config = if initial_full {
            Config::default()
        } else {
            config
        };
        let view = ConfigView {
            effective: config,
            full_expires_at: None,
            freed_bytes: 0,
        };
        let (changes, _) = watch::channel(view.clone());
        let (live, _) = broadcast::channel(1024);
        let (tx, rx) = mpsc::channel();
        let this = Self(Arc::new(Inner {
            tx,
            storage: Mutex::new(storage),
            config: RwLock::new(Arc::new(view)),
            queue: queue::Queue::default(),
            pending: AtomicUsize::new(0),
            deferred: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
            write_timeouts: AtomicUsize::new(0),
            live,
            changes,
            join: Mutex::new(None),
        }));
        let worker = this.clone();
        *this.0.join.lock() = Some(
            thread::Builder::new()
                .name("butler-log".into())
                .spawn(move || worker.run(&rx))?,
        );
        if initial_full {
            this.configure(Config::full())?;
        }
        Ok(this)
    }
    pub fn enabled(&self, category: &str, level: &str) -> bool {
        self.0.config.read().effective.enabled(category, level)
    }
    pub(crate) fn record_deferred(
        &self,
        category: &str,
        level: &str,
        bytes: usize,
        make: impl FnOnce() -> Record + Send + Sync + 'static,
    ) {
        if !self.enabled(category, level) {
            return;
        }
        if self.0.deferred.fetch_add(bytes, Ordering::Relaxed) >= 16 * 1024 * 1024 {
            self.0.deferred.fetch_sub(bytes, Ordering::Relaxed);
            self.0.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if self
            .0
            .tx
            .send(Command::Deferred(Box::new(make), bytes))
            .is_err()
        {
            self.0.deferred.fetch_sub(bytes, Ordering::Relaxed);
        }
    }
    pub fn record(&self, row: Record) -> io::Result<()> {
        self.enqueue(row, None).map(|_| ())
    }
    /// Fixture seeding waits for the writer rather than exercising the lossy lane.
    #[cfg(feature = "e2e-fixtures")]
    pub fn record_reliable(&self, row: Record) -> io::Result<()> {
        if !self.enabled(&row.category, &row.level) {
            return Ok(());
        }
        self.send_record(row, false, None)?;
        if self.0.queue.bytes.load(Ordering::Relaxed) > 16 * 1024 * 1024 {
            self.flush()?;
        }
        Ok(())
    }
    fn enqueue(
        &self,
        row: Record,
        ack: Option<oneshot::Sender<io::Result<()>>>,
    ) -> io::Result<bool> {
        if !self.enabled(&row.category, &row.level) {
            return Ok(false);
        }
        let lossy = super::record::severity(&row.level) >= 4;
        if lossy && self.0.pending.fetch_add(1, Ordering::Relaxed) >= DEBUG_CAPACITY {
            self.0.pending.fetch_sub(1, Ordering::Relaxed);
            self.0.dropped.fetch_add(1, Ordering::Relaxed);
            return Ok(false);
        }
        self.send_record(row, lossy, ack)
    }
    fn send_record(
        &self,
        row: Record,
        lossy: bool,
        ack: Option<oneshot::Sender<io::Result<()>>>,
    ) -> io::Result<bool> {
        // A full lane cannot accept any payload; avoid encoding records it will discard.
        if !lossy && self.0.queue.reject_full(&row.level) {
            self.notify_queue_full()?;
            return Ok(false);
        }
        let encoded = match Encoded::new(row, &self.snapshot().effective) {
            Ok(encoded) => encoded,
            Err(error) => {
                if lossy {
                    self.0.pending.fetch_sub(1, Ordering::Relaxed);
                }
                return Err(error);
            }
        };
        let bytes = encoded.bytes();
        if !lossy && !self.0.queue.reserve(bytes, &encoded.level) {
            if !self.0.queue.notice.swap(true, Ordering::Relaxed) {
                self.0.tx.send(Command::Dropped).map_err(io::Error::other)?;
            }
            return Ok(false);
        }
        if let Err(error) = self.0.tx.send(Command::Record(encoded, lossy, bytes, ack)) {
            if !lossy {
                self.0.queue.bytes.fetch_sub(bytes, Ordering::Relaxed);
            }
            if lossy {
                self.0.pending.fetch_sub(1, Ordering::Relaxed);
            }
            return Err(io::Error::other(error));
        }
        Ok(true)
    }

    fn request<T>(&self, make: impl FnOnce(Reply<T>) -> Control) -> io::Result<T> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.0
            .tx
            .send(Command::Control(make(tx)))
            .map_err(io::Error::other)?;
        rx.recv().map_err(io::Error::other)?
    }
    pub fn flush(&self) -> io::Result<()> {
        self.request(Control::Flush)
    }
    pub fn configure(&self, config: Config) -> io::Result<ConfigView> {
        if !config.valid() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid log configuration",
            ));
        }
        self.request(|reply| Control::Configure(config, reply))
    }
    pub fn config(&self) -> ConfigView {
        self.snapshot().as_ref().clone()
    }
    pub(super) fn snapshot(&self) -> Arc<ConfigView> {
        self.0.config.read().clone()
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Record> {
        self.0.live.subscribe()
    }
    pub fn config_changes(&self) -> watch::Receiver<ConfigView> {
        self.0.changes.subscribe()
    }
    pub fn query(&self, q: &Query) -> io::Result<Page> {
        self.flush()?;
        let mut storage = self.0.storage.lock();
        storage.refresh()?;
        query::query(&storage.root, &storage.catalog, q)
    }
    pub fn storage(&self) -> io::Result<StorageView> {
        self.flush()?;
        let mut view = retention::usage(&self.0.storage.lock().root)?;
        view.write_timeouts = self.write_timeouts();
        view.last_write_error = self.0.storage.lock().last_write_error();
        Ok(view)
    }
    pub fn body(&self, reference: &str) -> io::Result<Vec<u8>> {
        super::bodies::read(&self.0.storage.lock().root, reference)
    }
    pub fn clear(&self) -> io::Result<u64> {
        self.request(Control::Clear)
    }
    pub fn export(
        &self,
        since: Option<&str>,
        until: Option<&str>,
        bodies: bool,
    ) -> io::Result<Vec<u8>> {
        self.flush()?;
        let mut storage = self.0.storage.lock();
        storage.refresh()?;
        Ok(export::export(
            std::io::Cursor::new(Vec::new()),
            &storage.root,
            &storage.catalog,
            &self.config().effective,
            since,
            until,
            bodies,
        )?
        .into_inner())
    }
    pub fn export_file(
        &self,
        since: Option<&str>,
        until: Option<&str>,
        bodies: bool,
    ) -> io::Result<std::fs::File> {
        use std::io::{Seek, SeekFrom};
        self.flush()?;
        let mut storage = self.0.storage.lock();
        storage.refresh()?;
        let mut file = export::export(
            tempfile::tempfile()?,
            &storage.root,
            &storage.catalog,
            &self.config().effective,
            since,
            until,
            bodies,
        )?;
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
    pub fn shutdown(&self) -> io::Result<()> {
        let result = self.request(Control::Shutdown);
        if let Some(join) = self.0.join.lock().take() {
            join.join()
                .map_err(|_| io::Error::other("log writer panicked"))??;
        }
        result
    }
    /// Drain and close within a short-lived producer's exit budget.
    /// The writer owns its files and may finish in the background after timeout.
    /// Service owners use `shutdown` to retain the durable close and thread join.
    pub async fn shutdown_bounded(&self, timeout: std::time::Duration) -> io::Result<()> {
        let (tx, rx) = oneshot::channel();
        self.0
            .tx
            .send(Command::Control(Control::ShutdownBounded(tx)))
            .map_err(io::Error::other)?;
        // A writer stalled in filesystem I/O must not hold the caller or its
        // Tokio blocking pool alive. The explicit command stops the worker
        // even though the global tracing subscriber still owns a sender.
        self.0.join.lock().take();
        tokio::time::timeout(timeout, rx)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "log writer shutdown timed out"))?
            .map_err(io::Error::other)?
    }
    #[cfg(feature = "e2e-fixtures")]
    pub fn expire_full(&self) -> io::Result<()> {
        self.request(Control::Expire)
    }
    #[cfg(feature = "e2e-fixtures")]
    pub fn sync_count(&self) -> io::Result<usize> {
        self.request(Control::SyncCount)
    }
    #[cfg(feature = "e2e-fixtures")]
    pub fn prune(&self) -> io::Result<()> {
        self.request(Control::Prune)
    }
    fn apply(&self, config: Config) -> io::Result<ConfigView> {
        let expires = if config.level == Preset::Full {
            self.config().full_expires_at.or_else(|| {
                Some(
                    (chrono::Utc::now() + chrono::Duration::minutes(60))
                        .to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
                )
            })
        } else {
            None
        };
        let view = ConfigView {
            effective: config,
            full_expires_at: expires,
            freed_bytes: 0,
        };
        *self.0.config.write() = Arc::new(view.clone());
        tracing::callsite::rebuild_interest_cache();
        self.0.changes.send_replace(view.clone());
        let freed = self.0.storage.lock().configure(&view.effective);
        let mut view = view;
        match freed {
            Ok(bytes) => view.freed_bytes = bytes,
            Err(error) => self.report_error(&error),
        }
        *self.0.config.write() = Arc::new(view.clone());
        Ok(view)
    }
    fn write(&self, row: Encoded) -> io::Result<()> {
        let snapshot = self.snapshot();
        let config = &snapshot.effective;
        if !config.enabled(&row.category, &row.level) {
            return Ok(());
        }
        self.persist(row, config)
    }
    fn persist(&self, row: Encoded, config: &Config) -> io::Result<()> {
        let row = self.0.storage.lock().write(row, config)?;
        if self.0.live.receiver_count() > 0 {
            let _ = self.0.live.send(row);
        }
        Ok(())
    }
    fn write_queued(&self, row: Encoded, lossy: bool) -> io::Result<()> {
        if lossy {
            self.0.pending.fetch_sub(1, Ordering::Relaxed);
        }
        self.write(row)?;
        let dropped = if self.0.pending.load(Ordering::Relaxed) == 0 {
            self.0.dropped.swap(0, Ordering::Relaxed)
        } else {
            0
        };
        if dropped > 0 {
            self.write(Encoded::new(
                Record::new(
                    "WARN",
                    "lifecycle",
                    "logs.dropped",
                    &format!("dropped {dropped}"),
                ),
                &self.config().effective,
            )?)?;
        }
        self.report_drops()?;
        Ok(())
    }
    fn report_error(&self, error: &io::Error) {
        eprintln!("structured log writer I/O failure: {error}");
    }
    pub fn root(&self) -> PathBuf {
        self.0.storage.lock().root.clone()
    }
}
