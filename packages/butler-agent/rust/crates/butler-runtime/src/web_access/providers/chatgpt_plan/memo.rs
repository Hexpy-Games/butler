//! Process-local unsupported hosted search, scoped to a runtime and selection.
use crate::web_access::{WebAccessCode, service::WebAccessError};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::LazyLock,
};
type Key = (String, String);
static MEMO: LazyLock<Mutex<HashMap<PathBuf, Key>>> = LazyLock::new(Default::default);
pub(super) fn admit(root: &Path, key: &Key) -> Result<(), WebAccessError> {
    let mut memo = MEMO.lock();
    if memo.get(root) == Some(key) {
        return Err(failed());
    }
    memo.remove(root);
    Ok(())
}
pub(super) fn unsupported(root: &Path, key: &Key) {
    MEMO.lock().insert(root.to_owned(), key.clone());
}
pub(super) fn failed() -> WebAccessError {
    WebAccessError::new(
        WebAccessCode::WebSearchProviderFailed,
        "ChatGPT plan web search is unavailable.",
    )
}
