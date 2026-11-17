//! Main-thread, in-process CEF off-screen rendering. No gpui types cross this boundary.
//! macOS copies frames into IOSurface-backed CoreVideo buffers (gpu.rs, frame_pool.rs);
//! Windows copies them into pooled D3D11 shared textures (d3d.rs, d3d_pool.rs);
//! Linux copies the software `on_paint` buffer into CPU frames (soft.rs).
#[cfg(cef_osr)]
mod devtools;
mod ime_state;
mod types;
#[cfg(not(cef_osr))]
mod unsupported;
pub use ime_state::OsrIme;
pub use types::*;
#[cfg(not(cef_osr))]
pub use unsupported::{OsrFrame, OsrRuntime};

#[cfg(windows)]
mod d3d;
#[cfg(windows)]
mod d3d_pool;
#[cfg(cef_osr)]
mod dialogs;
#[cfg(cef_osr)]
mod downloads;
#[cfg(target_os = "macos")]
mod frame_pool;
#[cfg(target_os = "macos")]
mod gpu;
#[cfg(cef_osr)]
mod handlers;
#[cfg(cef_osr)]
mod ime;
#[cfg(cef_osr)]
mod input;
#[cfg(cef_osr)]
mod paint;
#[cfg(cef_osr)]
mod popups;
#[cfg(cef_osr)]
mod pump;
#[cfg(target_os = "linux")]
mod soft;
#[cfg(cef_osr)]
mod state;

#[cfg(cef_osr)]
use cef::{ImplBrowser, ImplBrowserHost, ImplFrame};
#[cfg(target_os = "macos")]
use core_video::pixel_buffer::CVPixelBuffer as Frame;
#[cfg(windows)]
pub use d3d::read_bgra_pixel;
#[cfg(windows)]
pub use d3d_pool::OsrFrame;
#[cfg(windows)]
use d3d_pool::OsrFrame as Frame;
#[cfg(target_os = "macos")]
pub use gpu::read_bgra_pixel;
#[cfg(target_os = "linux")]
use soft::OsrFrame as Frame;
#[cfg(target_os = "linux")]
pub use soft::{OsrFrame, read_bgra_pixel};
#[cfg(cef_osr)]
use state::{Events, Page, PageRef, Phase};
#[cfg(cef_osr)]
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

#[cfg(cef_osr)]
static STARTED: AtomicBool = AtomicBool::new(false);
#[cfg(cef_osr)]
const FALLBACK: Duration = Duration::from_nanos(1_000_000_000 / 30);

/// All runtime methods and sink events run on the UI thread.
pub trait OsrSink: 'static {
    fn event(&self, page: u64, event: OsrEvent);
}

/// Called from any thread. Schedule a timer on the UI loop, then call `OsrRuntime::pump` there.
/// Coalesce pending deadlines by keeping the earliest, including the visible-or-loading-page fallback.
pub type PumpScheduler = std::sync::Arc<dyn Fn(std::time::Duration) + Send + Sync>;

#[cfg(cef_osr)]
struct RuntimeState {
    pages: RefCell<HashMap<u64, PageRef>>,
    visible: Cell<usize>,
    contexts: RefCell<HashMap<String, (cef::RequestContext, usize)>>,
    popups: PopupPolicy,
    downloads: DownloadPolicy,
    auth: dialogs::AuthSender,
}

#[cfg(cef_osr)]
pub struct OsrRuntime {
    state: Rc<RuntimeState>,
    sink: Rc<dyn OsrSink>,
    schedule: PumpScheduler,
    auth_requests: std::sync::mpsc::Receiver<dialogs::AuthRequest>,
    _app: cef::App,
    #[cfg(target_os = "macos")]
    _framework: gpu::Framework,
    #[cfg(windows)]
    job: Option<crate::job::ChildJob>,
}

#[cfg(cef_osr)]
impl OsrRuntime {
    pub fn start(
        config: OsrConfig,
        sink: Rc<dyn OsrSink>,
        schedule: PumpScheduler,
        popups: PopupPolicy,
        downloads: DownloadPolicy,
    ) -> Result<Self, OsrError> {
        #[cfg(target_os = "macos")]
        if objc2::MainThreadMarker::new().is_none() {
            return Err(OsrError("CEF must start on the main thread".into()));
        }
        if STARTED.swap(true, Ordering::SeqCst) {
            return Err(OsrError("CEF already started in this process".into()));
        }
        Self::initialize(config, sink, schedule, popups, downloads)
    }

    fn initialize(
        config: OsrConfig,
        sink: Rc<dyn OsrSink>,
        schedule: PumpScheduler,
        popups: PopupPolicy,
        downloads: DownloadPolicy,
    ) -> Result<Self, OsrError> {
        #[cfg(target_os = "macos")]
        let framework = gpu::Framework::load(&config.framework_dir)?;
        #[cfg(target_os = "macos")]
        crate::mac::install_application();
        let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
        let adapter = config.adapter_luid;
        #[cfg(windows)]
        d3d::set_adapter(adapter);
        let settings = settings(config)?;
        // Created before CEF starts; kept until the runtime drops, which ends any helper left.
        #[cfg(windows)]
        let job = crate::job::ChildJob::create()
            .map_err(|error| eprintln!("no helper job: {error}"))
            .ok();
        #[cfg(windows)]
        let job_name = job.as_ref().map(|job| job.name().to_owned());
        #[cfg(not(windows))]
        let job_name = None;
        let mut app = pump::OsrApp::new(pump::Pump::new(schedule.clone(), job_name), adapter);
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
        let (auth, auth_requests) = std::sync::mpsc::channel();
        Ok(Self {
            auth_requests,
            state: Rc::new(RuntimeState {
                pages: RefCell::default(),
                visible: Cell::new(0),
                contexts: RefCell::default(),
                popups,
                downloads,
                auth: dialogs::AuthSender {
                    sender: auth,
                    schedule: schedule.clone(),
                },
            }),
            sink,
            schedule,
            _app: app,
            #[cfg(target_os = "macos")]
            _framework: framework,
            // Last: it outlives the CEF shutdown in `Drop`.
            #[cfg(windows)]
            job,
        })
    }

    /// The App's kill-on-close helper job, when it was created.
    #[cfg(windows)]
    pub fn child_job_name(&self) -> Option<&str> {
        self.job.as_ref().map(crate::job::ChildJob::name)
    }

    pub fn pump(&self) {
        self.receive_auth();
        cef::do_message_loop_work();
        #[cfg(windows)]
        self.repaint_dropped();
        // Pump while a page is visible or loading: CEF does not always announce the work of a starting load.
        if self.state.visible.get() > 0
            || self
                .state
                .pages
                .borrow()
                .values()
                .any(|p| p.borrow().loading)
        {
            (self.schedule)(FALLBACK);
        }
    }

    pub fn open(
        &self,
        page: u64,
        url: &str,
        size: (u32, u32),
        scale: f32,
        profile: OsrProfile,
    ) -> Result<(), OsrError> {
        if self.state.pages.borrow().contains_key(&page) {
            return Err(OsrError("page already exists".into()));
        }
        let owner = match profile {
            OsrProfile::SignedIn => None,
            OsrProfile::SignedOut(owner) => Some(owner),
        };
        let mut context = owner
            .as_ref()
            .map(|owner| {
                self.state
                    .contexts
                    .borrow()
                    .get(owner)
                    .map(|(context, _)| context.clone())
                    .or_else(|| {
                        cef::request_context_create_context(
                            Some(&cef::RequestContextSettings::default()),
                            None,
                        )
                    })
                    .ok_or_else(|| OsrError("create request context failed".into()))
            })
            .transpose()?;
        let shared = Rc::new(RefCell::new(Page::new(size, scale)));
        shared.borrow_mut().signed_out_owner = owner.clone();
        let events = Events {
            page,
            sink: self.sink.clone(),
        };
        let mut client = handlers::client(shared.clone(), events, &Rc::downgrade(&self.state));
        let browser = cef::browser_host_create_browser_sync(
            Some(&cef::WindowInfo {
                windowless_rendering_enabled: 1,
                // Linux paints in software through `on_paint`.
                shared_texture_enabled: i32::from(cfg!(not(target_os = "linux"))),
                ..Default::default()
            }),
            Some(&mut client),
            Some(&url.into()),
            Some(&cef::BrowserSettings {
                windowless_frame_rate: 60,
                ..Default::default()
            }),
            None,
            context.as_mut(),
        )
        .ok_or_else(|| OsrError("create OSR browser failed".into()))?;
        if let (Some(owner), Some(context)) = (owner, context) {
            self.state
                .contexts
                .borrow_mut()
                .entry(owner)
                .or_insert((context, 0))
                .1 += 1;
        }
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
    pub fn eval(&self, page: u64, js: &str) {
        if let Some(frame) = self.browser(page).and_then(|b| b.main_frame()) {
            frame.execute_java_script(Some(&js.into()), None, 0);
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
            // Windows keeps its device and fences; the pool replaces textures on a new size.
            #[cfg(target_os = "macos")]
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
            if p.phase == Phase::Closing || (p.phase == Phase::Visible) == visible {
                return;
            }
            p.phase = if visible {
                Phase::Visible
            } else {
                Phase::Hidden
            };
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
        self.cancel_dialogs(page);
        let Some(p) = self.page(page) else {
            return;
        };
        {
            let mut p = p.borrow_mut();
            if p.phase == Phase::Closing {
                return;
            }
            let was_visible = p.phase == Phase::Visible;
            p.phase = Phase::Closing;
            if was_visible {
                self.state.visible.set(self.state.visible.get() - 1);
            }
            p.release_frames();
        }
        if let Some(h) = self.host(page) {
            h.close_browser(1);
        }
    }
    pub fn frame(&self, page: u64) -> Option<Frame> {
        self.page(page).and_then(|p| p.borrow().frame.clone())
    }
    pub fn shutdown(self) {
        drop(self);
    }
}

#[cfg(cef_osr)]
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
        #[cfg(windows)]
        d3d::release_device();
    }
}

#[cfg(cef_osr)]
fn settings(config: OsrConfig) -> Result<cef::Settings, OsrError> {
    let OsrConfig {
        framework_dir,
        helper_path,
        profile_dir,
        locale,
        user_agent,
        adapter_luid: _,
    } = config;
    std::fs::create_dir_all(&profile_dir).map_err(|e| OsrError(e.to_string()))?;
    #[cfg(target_os = "macos")]
    #[expect(
        clippy::disallowed_methods,
        reason = "macOS-only CEF boundary; Windows extended paths cannot occur here"
    )]
    let profile_dir = profile_dir
        .canonicalize()
        .map_err(|e| OsrError(e.to_string()))?;
    // Not canonicalize: its Windows `\\?\` form never matches other paths; CEF needs an absolute path.
    #[cfg(not(target_os = "macos"))]
    let profile_dir = std::path::absolute(&profile_dir).map_err(|e| OsrError(e.to_string()))?;
    let profile = profile_dir
        .to_str()
        .ok_or_else(|| OsrError("profile path is not UTF-8".into()))?;
    let path = |p: &std::path::Path| cef::CefString::from(p.to_string_lossy().as_ref());
    Ok(cef::Settings {
        windowless_rendering_enabled: 1,
        external_message_pump: 1,
        root_cache_path: profile.into(),
        cache_path: path(&profile_dir.join("cache")),
        #[cfg(target_os = "macos")]
        framework_dir_path: path(&framework_dir),
        #[cfg(not(target_os = "macos"))]
        resources_dir_path: path(&framework_dir),
        #[cfg(not(target_os = "macos"))]
        locales_dir_path: path(&framework_dir.join("locales")),
        browser_subprocess_path: path(&helper_path),
        locale: locale.as_str().into(),
        user_agent: user_agent.as_str().into(),
        log_file: path(&profile_dir.join("cef.log")),
        log_severity: cef::LogSeverity::WARNING,
        ..Default::default()
    })
}

/// Chromium version from the pinned CEF bindings.
pub fn chrome_version() -> String {
    format!(
        "{}.{}.{}.{}",
        cef_dll_sys::CHROME_VERSION_MAJOR,
        cef_dll_sys::CHROME_VERSION_MINOR,
        cef_dll_sys::CHROME_VERSION_BUILD,
        cef_dll_sys::CHROME_VERSION_PATCH
    )
}
