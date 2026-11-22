//! A remote computer's view of the main's memory (session environments).
//! The main hands over a read-only copy of its instructions and profile on
//! every connect; this side never contacts the main.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock};

/// The main's all-chats instructions and profile, as last handed over.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct MemoryCopy {
    pub rules: Vec<CopiedRule>,
    pub naming_profile: Option<String>,
    pub runtime_profile: Option<String>,
}

/// One active all-chats instruction of the main.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CopiedRule {
    pub handle: String,
    pub text: String,
    pub revision: String,
    pub expires_at: Option<String>,
}

#[derive(Default)]
struct State {
    copy: Option<Arc<MemoryCopy>>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Mutex::default);

/// Replaces the copy with the one the main just handed over.
pub fn replace_copy(copy: MemoryCopy) {
    STATE.lock().copy = Some(Arc::new(copy));
}

/// The copy from the main's last connect since this process started.
pub fn copy() -> Option<Arc<MemoryCopy>> {
    STATE.lock().copy.clone()
}
