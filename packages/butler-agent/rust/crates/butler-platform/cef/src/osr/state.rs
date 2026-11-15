use super::{Frame, OsrIme, OsrSink};
#[cfg(windows)]
use super::{d3d::GpuCopy, d3d_pool::FramePool};
#[cfg(target_os = "macos")]
use super::{frame_pool::FramePool, gpu::GpuCopy};
use std::{cell::RefCell, rc::Rc};

pub(super) type PageRef = Rc<RefCell<Page>>;
pub(super) struct Page {
    pub(super) size: (u32, u32),
    pub(super) scale: f32,
    pub(super) visible: bool,
    pub(super) closing: bool,
    pub(super) embed: Option<super::embed::Policy>,
    pub(super) signed_out_owner: Option<String>,
    pub(super) browser: Option<cef::Browser>,
    pub(super) frame: Option<Frame>,
    pub(super) pool: FramePool,
    pub(super) gpu: Option<GpuCopy>,
    pub(super) paint_error_logged: bool,
    pub(super) ime: OsrIme,
    pub(super) dialog: Option<(u64, super::dialogs::Callback)>,
    pub(super) next_dialog: u64,
    pub(super) devtools: Option<cef::Registration>,
    pub(super) next_devtools: i32,
}
impl Page {
    pub(super) fn new(size: (u32, u32), scale: f32) -> Self {
        Self {
            size,
            scale,
            visible: true,
            closing: false,
            browser: None,
            signed_out_owner: None,
            embed: None,
            frame: None,
            pool: FramePool::default(),
            gpu: None,
            paint_error_logged: false,
            ime: OsrIme::default(),
            dialog: None,
            next_dialog: 0,
            devtools: None,
            next_devtools: 0,
        }
    }
    pub(super) fn release_frames(&mut self) {
        self.frame = None;
        self.pool = FramePool::default();
        self.gpu = None;
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
