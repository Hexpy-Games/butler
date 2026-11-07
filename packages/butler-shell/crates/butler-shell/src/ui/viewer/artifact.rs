//! `artifacts/ArtifactViewer`, `ArtifactBody`, `artifactDisplay`, `useArtifactText`,
//! `artifactActions`, `FileViewerArtifact` and `FileViewerDocument` (markdown, image, pdf,
//! code/text).
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::FileViewerEntry;

/// The body of one open file.
pub(crate) fn artifact_viewer(
    entry: &FileViewerEntry,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let _ = (entry, window, cx);
    gpui::Empty.into_any_element()
}
