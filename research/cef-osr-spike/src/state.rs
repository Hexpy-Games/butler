use core_foundation::base::TCFType;
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
    /// IOSurface ID of `frame` when it is CEF's own buffer (zero-copy).
    pub frame_surface: u32,
    /// Replaced zero-copy frames gpui may still be reading, with their IOSurface IDs.
    pub retired: Vec<(CVPixelBuffer, u32)>,
    pub pacer: Option<async_channel::Sender<()>>,
    pub hidden: bool,
    /// When the last BeginFrame was sent, until its frame arrives.
    pub awaiting: Option<Instant>,
    pub begin_frames: u64,
    pub begin_frame_to_frame_ms: Vec<f64>,
    pub late_frames: u64,
    pub unsolicited_frames: u64,
    pub overwritten_in_flight: u64,
    pub resurrected: u64,
}
impl Shared {
    /// Asks the BeginFrame pacer for a frame (external BeginFrame mode only).
    pub fn want_frame(&self) {
        if let Some(pacer) = &self.pacer {
            let _ = pacer.try_send(());
        }
    }
    /// Drops replaced frames that no submitted GPU work reads any more; true if none is left.
    pub fn retired_idle(&mut self) -> bool {
        self.retired.retain(|(f, _)| {
            gpui_apple::surface_observer::in_flight(f.as_concrete_TypeRef() as usize)
        });
        self.retired.is_empty()
    }
    /// A hidden view keeps no frame buffers or GPU copier; the next paint after it is shown recreates them.
    pub fn release_frames(&mut self) {
        self.frame = None;
        self.popup = None;
        self.retired.clear();
        self.view_pool = Default::default();
        self.popup_pool = Default::default();
        self.gpu = None;
    }
}
pub type SharedRef = Rc<RefCell<Shared>>;
#[derive(Clone)]
pub struct Runtime {
    pub shared: SharedRef,
    pub browser: Rc<RefCell<Option<cef::Browser>>>,
    pub background: Rc<RefCell<Vec<cef::Browser>>>,
    pub cdp: crate::cdp::Cdp,
    pub start: async_channel::Sender<()>,
}
impl Runtime {
    pub fn host(&self) -> Option<cef::BrowserHost> {
        use cef::ImplBrowser;
        self.browser.borrow().as_ref().and_then(|b| b.host())
    }
    pub fn input(&self) {
        let mut s = self.shared.borrow_mut();
        s.input_at = Some(Instant::now());
        s.want_frame();
    }
    pub fn close(&self) {
        use cef::ImplBrowserHost;
        if let Some(h) = self.host() {
            h.close_browser(1);
        }
        for browser in self.background.borrow().iter() {
            if let Some(h) = cef::ImplBrowser::host(browser) {
                h.close_browser(1);
            }
        }
    }
    pub fn release_frames(&self) {
        self.shared.borrow_mut().release_frames();
    }
}
