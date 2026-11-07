//! `app/fileViewerState.ts`: the open files per conversation.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use gpui::App;

use crate::ui::source::wire::SessionArtifactSummary;

/// A file open in a conversation's viewer (`FileViewerEntry`).
#[derive(Clone, Debug)]
pub(crate) enum FileViewerEntry {
    Artifact {
        id: String,
        artifact: Box<SessionArtifactSummary>,
    },
    Document {
        id: String,
        title: String,
    },
}

impl FileViewerEntry {
    pub(crate) fn id(&self) -> &str {
        match self {
            Self::Artifact { id, .. } | Self::Document { id, .. } => id,
        }
    }
}

/// One conversation's open files (`SessionFiles`).
#[derive(Clone, Debug, Default)]
pub(crate) struct SessionFiles {
    pub(crate) entries: Vec<FileViewerEntry>,
    pub(crate) active_id: Option<String>,
    pub(crate) shown: bool,
    pub(crate) raised: u64,
}

/// Open files per conversation; not persisted (`useFileViewerState`).
#[derive(Default)]
pub(crate) struct FileViewerState {
    pub(crate) sessions: HashMap<String, SessionFiles>,
}

impl gpui::Global for FileViewerState {}

static LAST_RAISE: AtomicU64 = AtomicU64::new(0);

/// Stamps a pane taking the conversation's right slot. The browser and the file viewer share the
/// slot; the pane with the later stamp holds it and the other stays open behind (`raiseRightSlot`).
pub(crate) fn raise_right_slot() -> u64 {
    LAST_RAISE.fetch_add(1, Ordering::Relaxed) + 1
}

/// `update` of the store: applies `next` to the session's files and repaints.
fn update(cx: &mut App, session: &str, next: impl FnOnce(SessionFiles) -> SessionFiles) {
    let state = cx.default_global::<FileViewerState>();
    let files = state.sessions.remove(session).unwrap_or_default();
    state.sessions.insert(session.to_owned(), next(files));
    cx.refresh_windows();
}

/// `open`
pub(crate) fn open(cx: &mut App, session: &str, entry: FileViewerEntry) {
    update(cx, session, |mut files| {
        let id = entry.id().to_owned();
        match files.entries.iter().position(|item| item.id() == id) {
            Some(index) => files.entries[index] = entry,
            None => files.entries.push(entry),
        }
        SessionFiles {
            active_id: Some(id),
            shown: true,
            raised: raise_right_slot(),
            ..files
        }
    });
}

/// `activate`
pub(crate) fn activate(cx: &mut App, session: &str, id: &str) {
    update(cx, session, |files| SessionFiles {
        active_id: Some(id.to_owned()),
        ..files
    });
}

/// `close`
pub(crate) fn close(cx: &mut App, session: &str, id: &str) {
    update(cx, session, |mut files| {
        let Some(index) = files.entries.iter().position(|item| item.id() == id) else {
            return files;
        };
        files.entries.remove(index);
        if files.active_id.as_deref() == Some(id) {
            let at = index.min(files.entries.len().saturating_sub(1));
            files.active_id = files.entries.get(at).map(|item| item.id().to_owned());
        }
        files.shown = files.shown && !files.entries.is_empty();
        files
    });
}

/// `setShown`
pub(crate) fn set_shown(cx: &mut App, session: &str, shown: bool) {
    update(cx, session, |files| SessionFiles {
        shown: shown && !files.entries.is_empty(),
        raised: if shown {
            raise_right_slot()
        } else {
            files.raised
        },
        ..files
    });
}

/// `useSessionFiles`
pub(crate) fn session_files(cx: &App, session: &str) -> SessionFiles {
    cx.try_global::<FileViewerState>()
        .and_then(|state| state.sessions.get(session))
        .cloned()
        .unwrap_or_default()
}

/// `RightSlotPane`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RightSlotPane {
    Browser,
    Viewer,
}

/// `rightSlotPane`: the pane raised last among those that want the slot. `browser` is the
/// browser's raise stamp while it wants the slot.
pub(crate) fn right_slot_pane(browser: Option<u64>, files: &SessionFiles) -> Option<RightSlotPane> {
    let viewer = files.shown && !files.entries.is_empty();
    match (browser, viewer) {
        (Some(raised), true) if raised > files.raised => Some(RightSlotPane::Browser),
        (_, true) => Some(RightSlotPane::Viewer),
        (Some(_), false) => Some(RightSlotPane::Browser),
        (None, false) => None,
    }
}
