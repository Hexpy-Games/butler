//! A turn owns unused stages; attachment materialization owns handed-off stages.
use super::*;
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock, Weak},
};
/// Owns all reader copies for one Agent process, under its instance lock.
/// Normal shutdown closes this after joining producers and materializers;
/// dropping a cancelled shutdown also removes copies synchronously.
pub struct ReaderStaging {
    data: Option<PathBuf>,
}
impl ReaderStaging {
    /// Discard previous-process copies before admitting any turn.
    pub fn new(data: PathBuf) -> io::Result<Self> {
        super::handoff::recover(&data)?;
        reset_reader_staging(&data)?;
        Ok(Self { data: Some(data) })
    }
    /// Finish on a blocking worker, before releasing the instance lock.
    pub fn cleanup(mut self) -> io::Result<()> {
        self.data
            .take()
            .map_or(Ok(()), |data| reset_reader_staging(&data))
    }
}
impl Drop for ReaderStaging {
    fn drop(&mut self) {
        if let Some(data) = self.data.take() {
            let _ = reset_reader_staging(&data);
        }
    }
}

type Key = (PathBuf, String);
struct State {
    data: PathBuf,
    turn: String,
    child_session: Option<String>,
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
    pub fn new(data: &Path, turn: &str, child_session: Option<String>) -> Self {
        let key = (data.to_path_buf(), turn.to_owned());
        let state = Arc::new(State {
            data: data.to_path_buf(),
            turn: turn.to_owned(),
            child_session,
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
pub fn handoff_staged(path: &Path, turn: &str) -> io::Result<PathBuf> {
    // Match stage_file's lock order: filesystem changes, registry, then turn files.
    let _changes = CHANGES
        .lock()
        .map_err(|_| io::Error::other("staging_unavailable"))?;
    let registry = registry()
        .lock()
        .map_err(|_| io::Error::other("staging_unavailable"))?;
    if let Some(state) = registry
        .values()
        .filter_map(Weak::upgrade)
        .find(|state| state.turn == turn)
    {
        let durable = state.data.join(crate::data_paths::MESSAGE_HANDOFFS);
        if path.starts_with(&durable) {
            super::handoff::adopt(path, &state.turn, state.child_session.as_deref())?;
            return Ok(path.to_path_buf());
        }
        if !path.starts_with(state.data.join(crate::data_paths::READER_STAGING)) {
            return Ok(path.to_path_buf());
        }
        let mut files = state
            .files
            .lock()
            .map_err(|_| io::Error::other("staging_unavailable"))?;
        let destination = super::handoff::promote(
            &state.data,
            &state.turn,
            state.child_session.as_deref(),
            path,
        )?;
        if let Some(handed) = files.get_mut(path) {
            *handed = true;
        }
        return Ok(destination);
    }
    // Ordinary artifacts do not use reader staging and have their own owner.
    if !path
        .parent()
        .and_then(Path::parent)
        .is_some_and(|root| root.ends_with(crate::data_paths::READER_STAGING))
    {
        return Ok(path.to_path_buf());
    }
    Err(io::Error::other("staging_owner_missing"))
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

/// Serialize reclamation with promotion/adoption, fencing ownership changes.
pub fn reclaim_handoff(path: &Path, identity: &str) -> io::Result<bool> {
    let _changes = CHANGES
        .lock()
        .map_err(|_| io::Error::other("staging_unavailable"))?;
    let current = match std::fs::read_to_string(path.join(".turn")) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    if current != identity {
        return Ok(false);
    }
    super::super::remove_tree(path)?;
    Ok(true)
}
