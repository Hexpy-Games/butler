use super::{Frame, OsrIme, OsrSink};
#[cfg(windows)]
use super::{d3d::GpuCopy, d3d_pool::FramePool};
#[cfg(target_os = "macos")]
use super::{frame_pool::FramePool, gpu::GpuCopy};
use std::{cell::RefCell, rc::Rc};

pub(super) type PageRef = Rc<RefCell<Page>>;
/// Whether the page is shown; once closing it stays hidden and ignores visibility changes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Hidden,
    Visible,
    Closing,
}
pub(super) struct Page {
    pub(super) size: (u32, u32),
    pub(super) scale: f32,
    pub(super) phase: Phase,
    /// Loading from creation; then as CEF reports it.
    pub(super) loading: bool,
    pub(super) signed_out_owner: Option<String>,
    /// A popup child whose browser CEF has not created yet: the opener page and CEF's popup id,
    /// which is unique only per opener.
    pub(super) popup: Option<(u64, i32)>,
    pub(super) browser: Option<cef::Browser>,
    pub(super) frame: Option<Frame>,
    #[cfg(not(target_os = "linux"))]
    pub(super) pool: FramePool,
    #[cfg(not(target_os = "linux"))]
    pub(super) gpu: Option<GpuCopy>,
    #[cfg(not(target_os = "linux"))]
    pub(super) paint_error_logged: bool,
    pub(super) ime: OsrIme,
    pub(super) dialog: Option<(u64, super::dialogs::Callback)>,
    pub(super) next_dialog: u64,
    pub(super) devtools: Option<cef::Registration>,
    pub(super) next_devtools: i32,
    pub(super) downloads: super::downloads::Transfers,
}
impl Page {
    pub(super) fn new(size: (u32, u32), scale: f32) -> Self {
        Self {
            size,
            scale,
            phase: Phase::Visible,
            loading: true,
            browser: None,
            signed_out_owner: None,
            popup: None,
            frame: None,
            #[cfg(not(target_os = "linux"))]
            pool: FramePool::default(),
            #[cfg(not(target_os = "linux"))]
            gpu: None,
            #[cfg(not(target_os = "linux"))]
            paint_error_logged: false,
            ime: OsrIme::default(),
            dialog: None,
            next_dialog: 0,
            devtools: None,
            next_devtools: 0,
            downloads: super::downloads::Transfers::default(),
        }
    }
    pub(super) fn release_frames(&mut self) {
        self.frame = None;
        #[cfg(not(target_os = "linux"))]
        {
            self.pool = FramePool::default();
            self.gpu = None;
        }
    }
}

#[derive(Clone)]
pub(super) struct Events {
    pub(super) page: u64,
    pub(super) sink: Rc<dyn OsrSink>,
}
impl Events {
    pub(super) fn emit(&self, event: super::OsrEvent) {
        self.sink.event(self.page, event);
    }
}
