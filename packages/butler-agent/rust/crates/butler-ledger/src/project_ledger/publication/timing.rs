//! Content-free publication diagnostics. Counts attempted filesystem API operations,
//! including metadata probes and directory entries, rather than elapsed-time budgets.
use std::cell::RefCell;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Instant;

static NEXT: AtomicU64 = AtomicU64::new(1);
tokio::task_local! { pub(super) static PUBLICATION: Arc<Measurement>; }
thread_local! { static ACTIVE: RefCell<Option<Arc<Measurement>>> = const { RefCell::new(None) }; }

pub(crate) struct Measurement {
    id: u64,
    operations: AtomicU64,
    started: Instant,
}

pub(super) fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
            == Some(std::ffi::OsStr::new("1"))
    })
}

impl Measurement {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            operations: AtomicU64::new(0),
            started: Instant::now(),
        })
    }
}

impl Drop for Measurement {
    fn drop(&mut self) {
        eprintln!(
            "command_file_timing phase=work_publication id={} event=end elapsed_us={} fs_operations={}",
            self.id,
            self.started.elapsed().as_micros(),
            self.operations.load(Ordering::Relaxed)
        );
    }
}

pub(crate) fn on_worker<T>(measurement: Option<Arc<Measurement>>, action: impl FnOnce() -> T) -> T {
    struct Reset(Option<Arc<Measurement>>);
    impl Drop for Reset {
        fn drop(&mut self) {
            ACTIVE.with(|active| active.replace(self.0.take()));
        }
    }
    let _reset = Reset(ACTIVE.with(|active| active.replace(measurement)));
    action()
}

pub(crate) fn operation() {
    ACTIVE.with(|active| {
        if let Some(measurement) = active.borrow().as_ref() {
            measurement.operations.fetch_add(1, Ordering::Relaxed);
        }
    });
}

pub(crate) fn current() -> Option<Arc<Measurement>> {
    PUBLICATION
        .try_with(Arc::clone)
        .ok()
        .or_else(|| ACTIVE.with(|active| active.borrow().clone()))
}

/// Box at the synchronous boundary so diagnostics do not multiply the
/// caller's async state across the scoped and unscoped await branches.
pub(crate) fn inherit<F: std::future::Future>(
    measurement: Option<Arc<Measurement>>,
    future: F,
) -> impl std::future::Future<Output = F::Output> {
    let future = Box::pin(future);
    async move {
        match measurement {
            Some(measurement) => PUBLICATION.scope(measurement, future).await,
            None => future.await,
        }
    }
}

pub(crate) fn measure<F: std::future::Future>(
    future: F,
) -> impl std::future::Future<Output = F::Output> {
    let measurement = current().or_else(|| enabled().then(Measurement::new));
    inherit(measurement, future)
}

pub(crate) struct Phase(Option<(&'static str, Instant, Arc<Measurement>, u64)>);
impl Phase {
    pub(crate) fn new(name: &'static str) -> Self {
        Self(current().map(|measurement| {
            let before = measurement.operations.load(Ordering::Relaxed);
            eprintln!("command_file_timing phase={name} id={} event=entry utc_us={} elapsed_us=0 fs_operations=0",
                measurement.id, utc_us());
            (name, Instant::now(), measurement, before)
        }))
    }
}
impl Drop for Phase {
    fn drop(&mut self) {
        if let Some((name, started, measurement, before)) = &self.0 {
            let count = measurement.operations.load(Ordering::Relaxed);
            eprintln!(
                "command_file_timing phase={name} id={} event=end utc_us={} elapsed_us={} fs_operations={}",
                measurement.id,
                utc_us(),
                started.elapsed().as_micros(),
                count - before
            );
        }
    }
}

pub(crate) mod fs;

fn utc_us() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
}
