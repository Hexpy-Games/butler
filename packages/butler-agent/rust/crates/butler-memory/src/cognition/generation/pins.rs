//! Process-local generation reader pins. Serving selection is rechecked after pinning.
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

type OnDrain = Box<dyn FnOnce() + Send>;
static READERS: LazyLock<Mutex<HashMap<PathBuf, Weak<Reader>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
pub(crate) struct GenerationPin(Arc<Reader>);
struct Reader {
    path: PathBuf,
    retiring: AtomicBool,
    on_drain: Mutex<Option<OnDrain>>,
}
impl Drop for Reader {
    fn drop(&mut self) {
        if let Some(callback) = self.on_drain.get_mut().take() {
            callback();
        }
    }
}
impl std::fmt::Debug for GenerationPin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.path.fmt(formatter)
    }
}
impl PartialEq for GenerationPin {
    fn eq(&self, other: &Self) -> bool {
        self.0.path == other.0.path
    }
}

pub(crate) fn pin(path: &Path) -> GenerationPin {
    let mut readers = READERS.lock();
    let reader = readers
        .get(path)
        .and_then(Weak::upgrade)
        .unwrap_or_else(|| {
            let reader = Arc::new(Reader {
                path: path.to_owned(),
                retiring: AtomicBool::new(false),
                on_drain: Mutex::new(None),
            });
            readers.insert(path.to_owned(), Arc::downgrade(&reader));
            reader
        });
    GenerationPin(reader)
}

pub(crate) fn pinned(path: &Path) -> bool {
    READERS
        .lock()
        .get(path)
        .is_some_and(|reader| reader.strong_count() > 0)
}

pub(super) fn on_drain(path: &Path, callback: OnDrain) {
    let reader = READERS.lock().get(path).and_then(Weak::upgrade);
    if let Some(reader) = reader {
        butler_core::diagnostic!(
            "[memory-reset-reader-drain] readers={}",
            Arc::strong_count(&reader) - 1
        );
        *reader.on_drain.lock() = Some(callback);
    } else {
        callback();
    }
}

pub(crate) fn mark_retiring(path: &Path) {
    if let Some(reader) = READERS.lock().get(path).and_then(Weak::upgrade) {
        reader.retiring.store(true, Ordering::Release);
    }
}
impl GenerationPin {
    pub(crate) fn is_retiring(&self) -> bool {
        self.0.retiring.load(Ordering::Acquire)
    }
}
