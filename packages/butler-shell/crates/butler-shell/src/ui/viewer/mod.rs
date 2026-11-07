//! The file viewer (non-HTML modes): `FileViewerPane`, `FileViewerFrame`, `FileViewerToggle`,
//! `useRightSlot`, in the AdaptiveShell split pane with tabs on TabStrip.
mod artifact;
mod state;

use gpui::{AnyElement, App, Window};

pub(crate) use state::{FileViewerEntry, FileViewerState, SessionFiles};

/// The viewer pane of a conversation; `None` while it is hidden or has no files.
pub(crate) fn file_viewer_pane(
    session: &str,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = artifact::artifact_viewer;
    let _ = (session, window, cx);
    None
}
