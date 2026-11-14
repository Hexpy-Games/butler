//! Main-thread, in-process CEF off-screen rendering. No gpui types cross this boundary.
mod frame_pool;
mod gpu;
mod handlers;
mod ime;
mod input;
mod paint;
mod pump;
mod state;
mod types;

use cef::{ImplBrowser, ImplBrowserHost, ImplFrame};
use core_video::pixel_buffer::CVPixelBuffer;
pub use gpu::read_bgra_pixel;
pub use ime::OsrIme;
use state::{Events, Page, PageRef};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
pub use types::*;

static STARTED: AtomicBool = AtomicBool::new(false);
const FALLBACK: Duration = Duration::from_nanos(1_000_000_000 / 30);

/// All runtime methods and sink events run on the AppKit main thread.
pub trait OsrSink: 'static {
    fn event(&self, page: u64, event: OsrEvent);
}

/// Called from any thread. Schedule a timer on the UI loop, then call `OsrRuntime::pump` there.
/// Coalesce pending deadlines by keeping the earliest, including the visible-page fallback.
pub type PumpScheduler = Arc<dyn Fn(Duration) + Send + Sync>;

struct RuntimeState {
    pages: RefCell<HashMap<u64, PageRef>>,
    visible: Cell<usize>,
}

pub struct OsrRuntime {
    state: Rc<RuntimeState>,
    sink: Rc<dyn OsrSink>,
    schedule: PumpScheduler,
    _app: cef::App,
    _framework: gpu::Framework,
}

impl OsrRuntime {
    pub fn start(
        config: OsrConfig,
        sink: Rc<dyn OsrSink>,
        schedule: PumpScheduler,
    ) -> Result<Self, OsrError> {
        if objc2::MainThreadMarker::new().is_none() {
            return Err(OsrError("CEF must start on the main thread".into()));
        }
        if STARTED.swap(true, Ordering::SeqCst) {
            return Err(OsrError("CEF already started in this process".into()));
        }
        Self::initialize(config, sink, schedule)
    }

    fn initialize(
        config: OsrConfig,
        sink: Rc<dyn OsrSink>,
        schedule: PumpScheduler,
    ) -> Result<Self, OsrError> {
        let OsrConfig {
            framework_dir,
            helper_path,
            profile_dir,
            locale,
            user_agent,
        } = config;
        let framework = gpu::Framework::load(&framework_dir)?;
        crate::mac::install_application();
        let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
        std::fs::create_dir_all(&profile_dir).map_err(|e| OsrError(e.to_string()))?;
        #[expect(
            clippy::disallowed_methods,
            reason = "macOS-only CEF boundary; Windows extended paths cannot occur here"
        )]
        let profile_dir = profile_dir
            .canonicalize()
            .map_err(|e| OsrError(e.to_string()))?;
        let profile = profile_dir
            .to_str()
            .ok_or_else(|| OsrError("profile path is not UTF-8".into()))?;
        let settings = cef::Settings {
            windowless_rendering_enabled: 1,
            external_message_pump: 1,
            root_cache_path: profile.into(),
            cache_path: profile_dir.join("cache").to_string_lossy().as_ref().into(),
            framework_dir_path: framework_dir.to_string_lossy().as_ref().into(),
            browser_subprocess_path: helper_path.to_string_lossy().as_ref().into(),
            locale: locale.as_str().into(),
            user_agent: user_agent.as_str().into(),
            log_file: profile_dir
                .join("cef.log")
                .to_string_lossy()
                .as_ref()
                .into(),
            log_severity: cef::LogSeverity::WARNING,
            ..Default::default()
        };
        let mut app = pump::OsrApp::new(pump::Pump::new(schedule.clone()));
        let args = cef::args::Args::new();
        if cef::initialize(
            Some(args.as_main_args()),
            Some(&settings),
            Some(&mut app),
            std::ptr::null_mut(),
        ) != 1
        {
            return Err(OsrError("CEF initialization failed".into()));
        }
        Ok(Self {
            state: Rc::new(RuntimeState {
                pages: RefCell::default(),
                visible: Cell::new(0),
            }),
            sink,
            schedule,
            _app: app,
            _framework: framework,
        })
    }

    pub fn pump(&self) {
        cef::do_message_loop_work();
        if self.state.visible.get() > 0 {
            (self.schedule)(FALLBACK);
        }
    }

    pub fn open(&self, page: u64, url: &str, size: (u32, u32), scale: f32) -> Result<(), OsrError> {
        if self.state.pages.borrow().contains_key(&page) {
            return Err(OsrError("page already exists".into()));
        }
        let shared = Rc::new(RefCell::new(Page::new(size, scale)));
        let events = Events {
            page,
            sink: self.sink.clone(),
        };
        let mut client = handlers::client(shared.clone(), events, Rc::downgrade(&self.state));
        let browser = cef::browser_host_create_browser_sync(
            Some(&cef::WindowInfo {
                windowless_rendering_enabled: 1,
                shared_texture_enabled: 1,
                ..Default::default()
            }),
            Some(&mut client),
            Some(&url.into()),
            Some(&cef::BrowserSettings {
                windowless_frame_rate: 60,
                ..Default::default()
            }),
            None,
            None,
        )
        .ok_or_else(|| OsrError("create OSR browser failed".into()))?;
        shared.borrow_mut().browser = Some(browser);
        self.state.pages.borrow_mut().insert(page, shared);
        self.state.visible.set(self.state.visible.get() + 1);
        (self.schedule)(Duration::ZERO);
        Ok(())
    }

    fn page(&self, page: u64) -> Option<PageRef> {
        self.state.pages.borrow().get(&page).cloned()
    }
    fn browser(&self, page: u64) -> Option<cef::Browser> {
        self.page(page).and_then(|p| p.borrow().browser.clone())
    }
    fn host(&self, page: u64) -> Option<cef::BrowserHost> {
        self.browser(page).and_then(|b| b.host())
    }
    pub fn navigate(&self, page: u64, url: &str) {
        if let Some(frame) = self.browser(page).and_then(|b| b.main_frame()) {
            frame.load_url(Some(&url.into()));
        }
    }
    pub fn back(&self, page: u64) {
        if let Some(b) = self.browser(page) {
            b.go_back();
        }
    }
    pub fn forward(&self, page: u64) {
        if let Some(b) = self.browser(page) {
            b.go_forward();
        }
    }
    pub fn reload(&self, page: u64) {
        if let Some(b) = self.browser(page) {
            b.reload();
        }
    }
    pub fn stop(&self, page: u64) {
        if let Some(b) = self.browser(page) {
            b.stop_load();
        }
    }

    pub fn resize(&self, page: u64, size: (u32, u32), scale: f32) {
        let Some(p) = self.page(page) else {
            return;
        };
        {
            let mut p = p.borrow_mut();
            p.size = size;
            p.scale = scale;
            p.release_frames();
        }
        if let Some(h) = self.host(page) {
            h.notify_screen_info_changed();
            h.was_resized();
        }
    }
    pub fn set_visible(&self, page: u64, visible: bool) {
        let Some(p) = self.page(page) else {
            return;
        };
        {
            let mut p = p.borrow_mut();
            if p.visible == visible || p.closing {
                return;
            }
            p.visible = visible;
            if visible {
                self.state.visible.set(self.state.visible.get() + 1);
            } else {
                self.state.visible.set(self.state.visible.get() - 1);
                p.release_frames();
            }
        }
        if let Some(h) = self.host(page) {
            h.was_hidden(i32::from(!visible));
            if visible {
                h.invalidate(cef::PaintElementType::VIEW);
                (self.schedule)(Duration::ZERO);
            }
        }
    }
    pub fn close(&self, page: u64) {
        let Some(p) = self.page(page) else {
            return;
        };
        {
            let mut p = p.borrow_mut();
            if p.closing {
                return;
            }
            p.closing = true;
            if p.visible {
                p.visible = false;
                self.state.visible.set(self.state.visible.get() - 1);
            }
            p.release_frames();
        }
        if let Some(h) = self.host(page) {
            h.close_browser(1);
        }
    }
    pub fn frame(&self, page: u64) -> Option<CVPixelBuffer> {
        self.page(page).and_then(|p| p.borrow().frame.clone())
    }
    pub fn shutdown(self) {
        drop(self);
    }
}

impl Drop for OsrRuntime {
    fn drop(&mut self) {
        let pages: Vec<_> = self.state.pages.borrow().keys().copied().collect();
        for page in pages {
            self.close(page);
        }
        // CEF requires every on_before_close before shutdown. Only pump during this teardown.
        while !self.state.pages.borrow().is_empty() {
            cef::do_message_loop_work();
        }
        cef::shutdown();
    }
}
