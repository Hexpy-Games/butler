//! `app/fileViewerState.ts`: the open files per conversation.
use std::collections::HashMap;

use crate::ui::source::wire::SessionArtifactSummary;

/// A file open in a conversation's viewer (`FileViewerEntry`).
#[derive(Clone, Debug)]
pub(crate) enum FileViewerEntry {
    Artifact {
        id: String,
        artifact: SessionArtifactSummary,
    },
    Document {
        id: String,
        title: String,
    },
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
