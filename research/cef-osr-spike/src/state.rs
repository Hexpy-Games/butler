use core_video::pixel_buffer::CVPixelBuffer;
use gpui::{Bounds, Pixels};
use std::{cell::RefCell, rc::Rc, time::Instant};
pub type ContextMenu = (i32, i32, Vec<(i32, String)>, cef::RunContextMenuCallback);
#[derive(Default)]
pub struct Shared {
    pub bounds: Bounds<Pixels>,
    pub scale: f32,
    pub frame: Option<CVPixelBuffer>,
    pub popup: Option<CVPixelBuffer>,
    pub view_pool: crate::frame_pool::FramePool,
    pub popup_pool: crate::frame_pool::FramePool,
    pub gpu: Option<crate::unsafe_boundary::GpuCopy>,
    pub popup_rect: cef::Rect,
    pub popup_show: bool,
    pub frames: u64,
    pub pumps: u64,
    pub copies_ms: Vec<f64>,
    pub input_at: Option<Instant>,
    pub latencies_ms: Vec<f64>,
    pub cursor: gpui::CursorStyle,
    pub ime_bounds: Vec<cef::Rect>,
    pub selection: std::ops::Range<usize>,
    pub selected_text: String,
    pub closed: bool,
    pub first_paint: bool,
    pub frame_waiter: Option<(usize, usize, async_channel::Sender<()>)>,
    pub context: Option<ContextMenu>,
}
pub type SharedRef = Rc<RefCell<Shared>>;
#[derive(Clone)]
pub struct Runtime {
    pub shared: SharedRef,
    pub browser: Rc<RefCell<Option<cef::Browser>>>,
    pub cdp: crate::cdp::Cdp,
    pub start: async_channel::Sender<()>,
}
impl Runtime {
    pub fn host(&self) -> Option<cef::BrowserHost> {
        use cef::ImplBrowser;
        self.browser.borrow().as_ref().and_then(|b| b.host())
    }
    pub fn input(&self) {
        self.shared.borrow_mut().input_at = Some(Instant::now());
    }
    pub fn close(&self) {
        use cef::ImplBrowserHost;
        if let Some(h) = self.host() {
            h.close_browser(1);
        }
    }
    /// A hidden view keeps no frame buffers; they are recreated by the next paint after it is shown.
    pub fn release_frames(&self) {
        let mut s = self.shared.borrow_mut();
        s.frame = None;
        s.popup = None;
        s.view_pool = Default::default();
        s.popup_pool = Default::default();
    }
}
