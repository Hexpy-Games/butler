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
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, watch};

const DEBUG_CAPACITY: usize = 8192;
type Reply<T> = mpsc::SyncSender<io::Result<T>>;
enum Command {
    Record(Box<Record>, bool),
    Flush(Reply<()>),
    Configure(Config, Reply<ConfigView>),
    Clear(Reply<u64>),
    Shutdown(Reply<()>),
    #[cfg(feature = "e2e-fixtures")]
    Expire(Reply<()>),
}
struct Inner {
    tx: mpsc::SyncSender<Command>,
    storage: Mutex<Storage>,
    config: RwLock<ConfigView>,
    pending: AtomicUsize,
    dropped: AtomicUsize,
    live: broadcast::Sender<Record>,
    changes: watch::Sender<ConfigView>,
    join: Mutex<Option<thread::JoinHandle<io::Result<()>>>>,
}
#[derive(Clone)]
pub struct Logger(Arc<Inner>);
impl Logger {
    pub fn open(data: &Path, config: Config) -> io::Result<Self> {
        if !config.valid() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid log configuration",
            ));
        }
        let storage = Storage::open(data.join("logs"), &config)?;
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
        let (tx, rx) = mpsc::sync_channel(16384);
        let this = Self(Arc::new(Inner {
            tx,
            storage: Mutex::new(storage),
            config: RwLock::new(view),
            pending: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
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
    pub fn record(&self, row: Record) -> io::Result<()> {
        self.enqueue(row)
    }
    /// Fixture seeding waits for the writer rather than exercising the lossy lane.
    #[cfg(feature = "e2e-fixtures")]
    pub fn record_reliable(&self, row: Record) -> io::Result<()> {
        if !self.enabled(&row.category, &row.level) {
            return Ok(());
        }
        self.0
            .tx
            .send(Command::Record(Box::new(row), false))
            .map_err(io::Error::other)
    }
    fn enqueue(&self, row: Record) -> io::Result<()> {
        if !self.enabled(&row.category, &row.level) {
            return Ok(());
        }
        let lossy = super::record::severity(&row.level) >= 4;
        if lossy && self.0.pending.fetch_add(1, Ordering::Relaxed) >= DEBUG_CAPACITY {
            self.0.pending.fetch_sub(1, Ordering::Relaxed);
            self.0.dropped.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
        let command = Command::Record(Box::new(row), lossy);
        if lossy {
            match self.0.tx.try_send(command) {
                Ok(()) => Ok(()),
                Err(mpsc::TrySendError::Full(_)) => {
                    self.0.pending.fetch_sub(1, Ordering::Relaxed);
                    self.0.dropped.fetch_add(1, Ordering::Relaxed);
                    Ok(())
                }
                Err(e) => Err(io::Error::other(e)),
            }
        } else {
            self.0.tx.send(command).map_err(io::Error::other)
        }
    }
    fn request<T>(&self, make: impl FnOnce(Reply<T>) -> Command) -> io::Result<T> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.0.tx.send(make(tx)).map_err(io::Error::other)?;
        rx.recv().map_err(io::Error::other)?
    }
    pub fn flush(&self) -> io::Result<()> {
        self.request(Command::Flush)
    }
    pub fn configure(&self, config: Config) -> io::Result<ConfigView> {
        if !config.valid() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid log configuration",
            ));
        }
        self.request(|reply| Command::Configure(config, reply))
    }
    pub fn config(&self) -> ConfigView {
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
        retention::usage(&self.0.storage.lock().root)
    }
    pub fn body(&self, reference: &str) -> io::Result<Vec<u8>> {
        super::bodies::read(&self.0.storage.lock().root, reference)
    }
    pub fn clear(&self) -> io::Result<u64> {
        self.request(Command::Clear)
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
        let result = self.request(Command::Shutdown);
        if let Some(join) = self.0.join.lock().take() {
            join.join()
                .map_err(|_| io::Error::other("log writer panicked"))??;
        }
        result
    }
    #[cfg(feature = "e2e-fixtures")]
    pub fn expire_full(&self) -> io::Result<()> {
        self.request(Command::Expire)
    }
    fn apply(&self, config: Config) -> io::Result<ConfigView> {
        let freed_bytes = self.0.storage.lock().configure(&config)?;
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
            freed_bytes,
        };
        *self.0.config.write() = view.clone();
        self.0.changes.send_replace(view.clone());
        Ok(view)
    }
    fn write(&self, row: Record) -> io::Result<()> {
        let config = self.config().effective;
        if !config.enabled(&row.category, &row.level) {
            return Ok(());
        }
        let row = self.0.storage.lock().write(row, &config)?;
        if self.0.live.receiver_count() > 0 {
            let _ = self.0.live.send(row);
        }
        Ok(())
    }
    fn write_queued(&self, row: Record, lossy: bool) -> io::Result<()> {
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
            self.write(Record::new(
                "WARN",
                "lifecycle",
                "logs.dropped",
                &format!("dropped {dropped}"),
            ))?;
        }
        Ok(())
    }
    fn run(&self, rx: &mpsc::Receiver<Command>) -> io::Result<()> {
        let mut flush_at: Option<Instant> = None;
        let mut full_until: Option<Instant> = None;
        let mut previous = Preset::Standard;
        loop {
            let deadline = [flush_at, full_until].into_iter().flatten().min();
            let command = if let Some(deadline) = deadline {
                match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(command) => Some(command),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match rx.recv() {
                    Ok(c) => Some(c),
                    Err(_) => break,
                }
            };
            if full_until.is_some_and(|d| Instant::now() >= d) {
                let mut config = self.config().effective;
                config.level = previous.clone();
                self.apply(config)?;
                full_until = None;
            }
            if flush_at.is_some_and(|d| Instant::now() >= d) {
                self.0.storage.lock().flush(false)?;
                flush_at = None;
            }
            let Some(command) = command else {
                continue;
            };
            match command {
                Command::Record(row, lossy) => {
                    self.write_queued(*row, lossy)?;
                    flush_at.get_or_insert_with(|| Instant::now() + Duration::from_secs(1));
                }
                Command::Configure(config, reply) => {
                    if config.level == Preset::Full && full_until.is_none() {
                        previous = self.config().effective.level;
                        full_until = Some(Instant::now() + Duration::from_secs(3600));
                    } else if config.level != Preset::Full {
                        full_until = None;
                    }
                    let _ = reply.send(self.apply(config));
                }
                Command::Flush(reply) => {
                    let _ = reply.send(self.0.storage.lock().flush(false));
                    flush_at = None;
                }
                Command::Clear(reply) => {
                    let _ = reply.send(self.0.storage.lock().clear());
                    flush_at = None;
                }
                Command::Shutdown(reply) => {
                    let _ = reply.send(self.0.storage.lock().close());
                    return Ok(());
                }
                #[cfg(feature = "e2e-fixtures")]
                Command::Expire(reply) => {
                    full_until = Some(Instant::now());
                    let _ = reply.send(Ok(()));
                }
            }
        }
        self.0.storage.lock().close()
    }
    pub fn root(&self) -> PathBuf {
        self.0.storage.lock().root.clone()
    }
}
