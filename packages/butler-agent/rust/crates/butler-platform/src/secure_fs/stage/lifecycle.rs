//! A turn owns unused stages; attachment materialization owns handed-off stages.
use super::*;
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock, Weak},
};
type Key = (PathBuf, String);
struct State {
    data: PathBuf,
    files: Mutex<HashMap<PathBuf, bool>>,
}
/// Releases unused copies when the bound turn ends, including cancellation.
pub struct StageScope {
    _state: Arc<State>,
}
fn registry() -> &'static Mutex<HashMap<Key, Weak<State>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<Key, Weak<State>>>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}
impl StageScope {
    /// Establish staging ownership before the turn can dispatch tools.
    pub fn new(data: &Path, turn: &str) -> Self {
        let key = (data.to_path_buf(), turn.to_owned());
        let state = Arc::new(State {
            data: data.to_path_buf(),
            files: Mutex::default(),
        });
        if let Ok(mut registry) = registry().lock() {
            registry.retain(|_, state| state.strong_count() > 0);
            registry.insert(key, Arc::downgrade(&state));
        }
        Self { _state: state }
    }
    /// Keep ownership while an admitted blocking operation finishes, even if
    /// the caller cancels before its worker starts or produces its result.
    pub fn for_operation(data: &Path, turn: &str) -> Option<Self> {
        let state = registry()
            .lock()
            .ok()?
            .get(&(data.to_path_buf(), turn.to_owned()))?
            .upgrade()?;
        Some(Self { _state: state })
    }
}
pub(super) fn register(data: &Path, turn: &str, path: &Path) {
    if let Ok(registry) = registry().lock()
        && let Some(state) = registry
            .get(&(data.to_path_buf(), turn.to_owned()))
            .and_then(Weak::upgrade)
        && let Ok(mut files) = state.files.lock()
    {
        files.insert(path.to_path_buf(), false);
    }
}
/// Transfer only selected closeout files to the attachment materializer. Their
/// display identity remains the original project path, never this private copy.
pub fn handoff_staged(path: &Path) {
    if let Ok(registry) = registry().lock() {
        for state in registry.values().filter_map(Weak::upgrade) {
            if let Ok(mut files) = state.files.lock()
                && let Some(handed) = files.get_mut(path)
            {
                *handed = true;
            }
        }
    }
}
impl Drop for State {
    fn drop(&mut self) {
        let mut staged = StagedFiles::new(&self.data);
        if let Ok(mut files) = self.files.lock() {
            for (path, handed) in files.drain() {
                if !handed {
                    staged.push(path);
                }
            }
        }
        drop(staged);
    }
}
