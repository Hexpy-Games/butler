// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `media/ImageViewerHost` and its state: one DS ImageViewer at the frame level.
use gpui::{AnyElement, App, Window};

/// One image the viewer can show.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
#[derive(Clone, Debug)]
pub(crate) struct ViewerImage {
    pub(crate) file_id: String,
    pub(crate) name: String,
}

#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
#[derive(Default)]
pub(crate) struct ImageViewerHost {
    open: Option<(Vec<ViewerImage>, usize)>,
}

#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
impl ImageViewerHost {
    pub(crate) fn open(&mut self, images: Vec<ViewerImage>, index: usize) {
        self.open = Some((images, index));
    }

    pub(crate) fn close(&mut self) {
        self.open = None;
    }

    /// The viewer overlay while open.
    pub(crate) fn render(&self, _window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
        None
    }
}
