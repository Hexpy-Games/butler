//! Headless CEF 156 host for Windows and Linux.
//! The agent's headless executor drives Chromium through the DevTools pipe:
//! `--remote-debugging-pipe` carries NUL-separated JSON messages.
//! This host accepts the executor's standard Chrome switches unchanged,
//! including `--user-data-dir` and `--proxy-server`.
//! CEF provides the full browser-level pipe endpoint natively; the host adds
//! `--headless` to run Chrome's headless mode without OS windows.
//! The renderer sandbox stays on. On Windows, CEF's `bootstrapc.exe`, renamed
//! to the DLL's stem, loads this DLL and passes sandbox info to `RunConsoleMain`.
//! This crate is the audited CEF unsafe boundary (D-P2); only that export is unsafe.

#[cfg(feature = "cef")]
mod app;
#[cfg(all(feature = "cef", windows))]
mod boot;

/// Run a CEF browser or helper process, passing bootstrap sandbox info through.
#[cfg(feature = "cef")]
pub fn run(sandbox_info: *mut u8) -> i32 {
    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    let args = cef::args::Args::new();
    let mut app = app::HostApp::new();
    let code = cef::execute_process(Some(args.as_main_args()), Some(&mut app), sandbox_info);
    if code >= 0 {
        return code;
    }

    let Some(profile) =
        std::env::args().find_map(|arg| arg.strip_prefix("--user-data-dir=").map(str::to_owned))
    else {
        eprintln!("missing --user-data-dir=<directory>");
        return 2;
    };
    let settings = cef::Settings {
        no_sandbox: 0,
        root_cache_path: cef::CefString::from(profile.as_str()),
        // No cache_path: the global context stays in memory (CEF's incognito mode); the executor's conversations use their own disposable contexts.
        log_severity: cef::LogSeverity::WARNING,
        ..Default::default()
    };
    if cef::initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        sandbox_info,
    ) != 1
    {
        eprintln!("failed to initialize CEF");
        return 1;
    }
    cef::run_message_loop();
    cef::shutdown();
    0
}
