use super::{OsrSink, frame_pool::FramePool, gpu::GpuCopy, ime::OsrIme};
use core_video::pixel_buffer::CVPixelBuffer;
use std::{cell::RefCell, rc::Rc};

pub(super) type PageRef = Rc<RefCell<Page>>;
pub(super) struct Page {
    pub(super) size: (u32, u32),
    pub(super) scale: f32,
    pub(super) visible: bool,
    pub(super) closing: bool,
    pub(super) browser: Option<cef::Browser>,
    pub(super) frame: Option<CVPixelBuffer>,
    pub(super) pool: FramePool,
    pub(super) gpu: Option<GpuCopy>,
    pub(super) paint_error_logged: bool,
    pub(super) ime: OsrIme,
}
impl Page {
    pub(super) fn new(size: (u32, u32), scale: f32) -> Self {
        Self {
            size,
            scale,
            visible: true,
            closing: false,
            browser: None,
            frame: None,
            pool: FramePool::default(),
            gpu: None,
            paint_error_logged: false,
            ime: OsrIme::default(),
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
