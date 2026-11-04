mod cdp;
mod cef_gate;
mod dialogs;
mod field;
mod frame_pool;
mod harness;
mod ime;
mod input;
mod perf;
mod presentation;
mod pump;
mod state;
mod ui;
mod unsafe_boundary;
use cef::ImplBrowserHost;
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::Write,
    path::PathBuf,
    rc::Rc,
    sync::OnceLock,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
const ROOT: &str = env!("CARGO_MANIFEST_DIR");
static CEF_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static LOG: OnceLock<PathBuf> = OnceLock::new();
static SELF_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn option(name: &str) -> Option<String> {
    std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|a| a[0] == name)
        .map(|a| a[1].clone())
}
fn flag(name: &str) -> bool {
    std::env::args().any(|a| a == name)
}
fn log(event: &str, data: Value) {
    let path = LOG.get_or_init(|| {
        let p = PathBuf::from(option("--log").unwrap_or_else(|| format!("{ROOT}/spike.log")));
        assert!(
            p.is_absolute()
                && p.parent()
                    .unwrap()
                    .canonicalize()
                    .unwrap()
                    .starts_with(ROOT)
        );
        p
    });
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    let mut bytes=serde_json::to_vec(&json!({"ts_ms":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(),"event":event,"data":data})).unwrap();
    bytes.push(b'\n');
    f.write_all(&bytes).unwrap();
}
fn main() {
    std::panic::set_hook(Box::new(|info| {
        log("panic", json!(info.to_string()));
        eprintln!("{info}");
    }));
    let exe = std::env::current_exe().unwrap();
    let helper = exe.to_string_lossy().contains(" Helper");
    let loader = cef::library_loader::LibraryLoader::new(&exe, helper);
    assert!(loader.load());
    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    let args = cef::args::Args::new();
    if helper {
        cef::execute_process(Some(args.as_main_args()), None, std::ptr::null_mut());
        return;
    }
    log(
        "startup",
        json!({"pid":std::process::id(),"software":flag("--software"),"self_test":flag("--self-test"),"home":std::env::var("HOME").ok()}),
    );
    presentation::install();
    gpui_platform::application().run(move |cx| start(args, cx));
    if CEF_STARTED.load(std::sync::atomic::Ordering::SeqCst) {
        cef::shutdown();
    }
    log("shutdown", json!(true));
    if flag("--self-test") && !SELF_OK.load(std::sync::atomic::Ordering::SeqCst) {
        std::process::exit(1);
    }
}
fn start(args: cef::args::Args, cx: &mut App) {
    let (pump_tx, pump_rx) = async_channel::unbounded();
    let (tx, rx) = async_channel::bounded(1);
    let shared = Rc::new(RefCell::new(state::Shared {
        scale: 2.,
        ..Default::default()
    }));
    let (start_tx, start_rx) = async_channel::bounded(1);
    let rt = state::Runtime {
        shared: shared.clone(),
        browser: Rc::default(),
        background: Rc::default(),
        cdp: cdp::Cdp::new(cx),
        start: start_tx.clone(),
    };
    let r = rt.clone();
    let window = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    if flag("--large") {
                        size(px(1600.), px(1000.))
                    } else {
                        size(px(1200.), px(800.))
                    },
                    cx,
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Butler CEF Spike".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            move |w, cx| {
                w.set_background_appearance(WindowBackgroundAppearance::Acrylic);
                let close = r.clone();
                w.on_window_should_close(cx, move |_, _| {
                    if close.host().is_none() {
                        return true;
                    }
                    close.close();
                    false
                });
                cx.new(|cx| ui::Spike::new(r, w, cx))
            },
        )
        .unwrap();
    let r = rt.clone();
    let init_pump_tx = pump_tx.clone();
    cx.on_window_closed(|cx, _| cx.quit()).detach();
    cx.spawn(async move |cx| {
        if start_rx.recv().await.is_err() {
            return;
        }
        initialize(&args, cef_gate::Pump::new(init_pump_tx), r.clone(), tx);
        let mut observer = r.cdp.observer();
        let registration = r
            .host()
            .unwrap()
            .add_dev_tools_message_observer(Some(&mut observer));
        let _ = window.update(cx, |_, w, _| w.refresh());
        while rx.recv().await.is_ok() {
            if r.shared.borrow().closed {
                r.browser.borrow_mut().take();
                drop(registration);
                // GPUI's macOS quit calls NSApplication::terminate, which exits rather
                // than returning from Application::run. Shut CEF down before that.
                cef::shutdown();
                CEF_STARTED.store(false, std::sync::atomic::Ordering::SeqCst);
                log("shutdown", json!(true));
                if flag("--self-test") && !SELF_OK.load(std::sync::atomic::Ordering::SeqCst) {
                    std::process::exit(1);
                }
                cx.update(|cx| cx.quit());
                break;
            }
            if window.update(cx, |_, w, _| w.refresh()).is_err() {
                r.close();
            }
        }
    })
    .detach();
    if !flag("--lazy") {
        let _ = start_tx.try_send(());
    }
    unsafe_boundary::observe_visibility(pump_tx.clone());
    pump::run(pump_rx, rt.clone(), cx);
    let tabs: usize = option("--tabs").map(|v| v.parse().unwrap()).unwrap_or(1);
    if tabs > 1 {
        let r = rt.clone();
        cx.spawn(async move |cx| {
            // Background tabs take the visible tab's laid-out size, known once it has painted.
            while r.shared.borrow().frames == 0 {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(100))
                    .await;
            }
            for index in 1..tabs {
                open_background_tab(&r, index).await;
            }
        })
        .detach();
    }
    harness::launch(window, rt, cx);
}
fn initialize(
    args: &cef::args::Args,
    pump: cef::BrowserProcessHandler,
    rt: state::Runtime,
    tx: async_channel::Sender<()>,
) {
    let profile = format!("{ROOT}/profile-pool");
    let bundle = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    std::fs::create_dir_all(&profile).unwrap();
    let settings = cef::Settings {
        no_sandbox: 1,
        windowless_rendering_enabled: 1,
        external_message_pump: 1,
        root_cache_path: profile.as_str().into(),
        cache_path: format!("{profile}/cache").as_str().into(),
        log_file: format!("{ROOT}/memory-evidence/cef-pool.log")
            .as_str()
            .into(),
        browser_subprocess_path: format!(
            "{}/Contents/Frameworks/ButlerCefSpike Helper.app/Contents/MacOS/ButlerCefSpike Helper",
            bundle.display()
        )
        .as_str()
        .into(),
        main_bundle_path: bundle.to_str().unwrap().into(),
        ..Default::default()
    };
    let mut app = cef_gate::CefApp::new(pump);
    let start = Instant::now();
    assert_eq!(
        cef::initialize(
            Some(args.as_main_args()),
            Some(&settings),
            Some(&mut app),
            std::ptr::null_mut()
        ),
        1
    );
    CEF_STARTED.store(true, std::sync::atomic::Ordering::SeqCst);
    log(
        "cef_initialized",
        json!({"elapsed_ms":start.elapsed().as_secs_f64()*1000.,"main_thread":true,"sandbox":false,"periodic_tick":true,"pump_max_ms":pump::max_delay().as_millis()}),
    );
    let s = rt.shared.clone();
    let mut client = client(&s, &tx);
    *rt.browser.borrow_mut() = create_browser(&mut client);
    assert!(rt.browser.borrow().is_some());
}
fn client(shared: &state::SharedRef, tx: &async_channel::Sender<()>) -> cef::Client {
    cef_gate::ClientBuilder::new(
        cef_gate::Paint::new(shared.clone(), tx.clone(), flag("--zero-copy")),
        cef_gate::Life::new(shared.clone(), tx.clone()),
        cef_gate::Display::new(shared.clone(), tx.clone()),
        dialogs::Menu::new(shared.clone(), tx.clone()),
        dialogs::Dialog::new(),
        dialogs::Js::new(),
    )
}
fn create_browser(client: &mut cef::Client) -> Option<cef::Browser> {
    let url = option("--url").unwrap_or_else(|| format!("file://{ROOT}/src/fixture.html"));
    assert!(
        url == format!("file://{ROOT}/src/fixture.html")
            || url == "https://github.com/Hexpy-Games/butler"
    );
    cef::browser_host_create_browser_sync(
        Some(&cef::WindowInfo {
            windowless_rendering_enabled: 1,
            shared_texture_enabled: i32::from(!flag("--software")),
            ..Default::default()
        }),
        Some(client),
        Some(&url.as_str().into()),
        Some(&cef::BrowserSettings {
            windowless_frame_rate: 60,
            background_color: 0,
            ..Default::default()
        }),
        None,
        None,
    )
}
/// Opens one background tab at the visible tab's size: it paints once, then is hidden
/// like a tab the user switched away from.
async fn open_background_tab(rt: &state::Runtime, index: usize) {
    let (bounds, scale) = {
        let s = rt.shared.borrow();
        (s.bounds, s.scale)
    };
    let shared = Rc::new(RefCell::new(state::Shared {
        bounds,
        scale,
        ..Default::default()
    }));
    let (tx, rx) = async_channel::bounded(1);
    let browser = create_browser(&mut client(&shared, &tx)).expect("Background tab");
    while shared.borrow().frames == 0 {
        assert!(rx.recv().await.is_ok());
    }
    use cef::ImplBrowser;
    browser.host().unwrap().was_hidden(1);
    let keep = flag("--keep-hidden-frames");
    if !keep {
        shared.borrow_mut().release_frames();
    }
    log(
        "background_tab",
        json!({"index":index,"frames":shared.borrow().frames,"released":!keep}),
    );
    rt.background.borrow_mut().push(browser);
}
