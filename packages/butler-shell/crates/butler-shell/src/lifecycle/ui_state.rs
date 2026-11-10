//! The first-frame settings cache (`<data>/app/ui-state.json`): the theme, language and text
//! size the last run showed, so the window paints them before the Agent answers `/settings`
//! (Electron's `butler:settings:v1` and splash appearance). The Agent stays the source of
//! truth and replaces these as soon as it answers; the file never decides the onboarding gate.
use std::io;
use std::path::Path;

use butler_platform::data_paths::APP_UI_STATE;
use gpui::App;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A cache this large is not ours; it reads as defaults.
const MAX_BYTES: u64 = 4096;

/// The Agent's own setting keys and values.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct UiState {
    pub(crate) appearance_theme: Option<String>,
    pub(crate) language: Option<String>,
    pub(crate) text_size: Option<String>,
}

impl UiState {
    /// The cached keys of a `/settings` answer.
    pub(crate) fn from_settings(raw: &Value) -> Self {
        let text = |key: &str| raw.get(key).and_then(Value::as_str).map(str::to_owned);
        Self {
            appearance_theme: text("appearance_theme"),
            language: text("language"),
            text_size: text("text_size"),
        }
    }
}

/// The saved state; a missing, oversized or unreadable file is today's defaults.
pub(crate) fn read(data: &Path) -> UiState {
    let path = data.join(APP_UI_STATE);
    let small = std::fs::metadata(&path).is_ok_and(|meta| meta.len() <= MAX_BYTES);
    small
        .then(|| std::fs::read(&path).ok())
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Writes the cache, unless there is no App runtime (the shot harness) or the data folder is
/// legacy (the App writes nothing there). A cache write failing changes nothing.
pub(crate) fn save(cx: &App, state: &UiState) {
    let Some(runtime) = super::runtime(cx) else {
        return;
    };
    let runtime = runtime.read(cx);
    if !runtime.legacy {
        let _ = write(&runtime.data, state);
    }
}

/// Temp file, then rename, so a reader never sees half a file.
fn write(data: &Path, state: &UiState) -> io::Result<()> {
    let path = data.join(APP_UI_STATE);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec(state)?)?;
    std::fs::rename(&temp, &path)
}
