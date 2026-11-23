use super::{Frame, OsrIme, OsrSink};
#[cfg(windows)]
use super::{d3d::GpuCopy, d3d_pool::FramePool};
#[cfg(target_os = "macos")]
use super::{frame_pool::FramePool, gpu::GpuCopy};
use std::collections::VecDeque;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

#[cfg(not(target_os = "linux"))]
pub(super) const QUEUE: usize = 2;

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
    /// Painted frames not yet drawn, oldest first; at most `QUEUE`. Linux paints in place and never queues.
    pub(super) queue: VecDeque<Frame>,
    /// The windowless frame rate last given to CEF.
    pub(super) rate: u32,
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
    pub(super) devtools_raw: Rc<Cell<bool>>,
    pub(super) downloads: super::downloads::Transfers,
    pub(super) loads: super::hold::Loads,
}
impl Page {
    pub(super) fn new(size: (u32, u32), scale: f32, rate: u32) -> Self {
        Self {
            size,
            scale,
            phase: Phase::Visible,
            loading: true,
            browser: None,
            signed_out_owner: None,
            popup: None,
            frame: None,
            queue: VecDeque::new(),
            rate,
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
            devtools_raw: Rc::default(),
            downloads: super::downloads::Transfers::default(),
            loads: super::hold::Loads::default(),
        }
    }
    #[cfg(not(target_os = "linux"))]
    pub(super) fn make_room(&mut self) {
        if self.queue.len() == QUEUE {
            self.queue.pop_front();
        }
    }
    #[cfg(not(target_os = "linux"))]
    pub(super) fn push(&mut self, frame: Frame) {
        self.queue.push_back(frame);
    }
    pub(super) fn release_frames(&mut self) {
        self.frame = None;
        self.queue.clear();
        self.release_pool();
    }
    pub(super) fn release_pool(&mut self) {
        #[cfg(not(target_os = "linux"))]
        {
            self.queue.clear();
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
