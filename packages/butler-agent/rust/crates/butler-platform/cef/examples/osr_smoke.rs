//! The OSR runtime end to end: first frame (centre pixel read from the frame: a separate GPU path
//! on macOS and Windows, the CPU frame on Linux), repaint, navigation events, shutdown. macOS: run inside the staged bundle. Windows: run from the stage.py output
//! directory (libcef.dll and the `butler_cef_host.exe` helper beside this executable). Linux: run
//! from the stage.py output directory (`libcef.so` and `butler-cef-host` beside this executable).
#[cfg(cef_osr)]
mod smoke {
    use butler_cef_host::osr::{OsrConfig, OsrEvent, OsrRuntime, OsrSink, read_bgra_pixel};
    use std::{
        cell::RefCell,
        error::Error,
        path::PathBuf,
        rc::Rc,
        sync::{
            Arc,
            mpsc::{self, Receiver, RecvTimeoutError},
        },
        time::{Duration, Instant},
    };

    const FIRST: &str = "data:text/html,<title>OSR first</title><body style='margin:0;background:rgb(20,80,140)'></body>";
    const SECOND: &str =
        "data:text/html,<title>OSR second</title><body style='background:rgb(140,80,20)'></body>";
    #[derive(Default)]
    struct Sink {
        events: RefCell<Vec<OsrEvent>>,
    }
    impl OsrSink for Sink {
        fn event(&self, _page: u64, event: OsrEvent) {
            self.events.borrow_mut().push(event);
        }
    }
    fn wait(
        runtime: &OsrRuntime,
        requests: &Receiver<Duration>,
        ready: impl Fn() -> bool,
    ) -> Result<(), Box<dyn Error>> {
        let end = Instant::now() + Duration::from_secs(30);
        let mut deadline = Instant::now();
        while !ready() {
            let now = Instant::now();
            if now >= end {
                return Err("OSR smoke timed out".into());
            }
            match requests.recv_timeout(deadline.min(end).saturating_duration_since(now)) {
                Ok(delay) => deadline = deadline.min(Instant::now() + delay),
                Err(RecvTimeoutError::Timeout) => {
                    runtime.pump();
                    deadline = end;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("pump scheduler disconnected".into());
                }
            }
        }
        Ok(())
    }
    fn verify(
        runtime: &OsrRuntime,
        sink: &Sink,
        requests: &Receiver<Duration>,
    ) -> Result<(), Box<dyn Error>> {
        let start = Instant::now();
        runtime.open(
            1,
            FIRST,
            (320, 240),
            1.,
            butler_cef_host::osr::OsrProfile::SignedIn,
        )?;
        wait(runtime, requests, || {
            sink.events
                .borrow()
                .iter()
                .any(|e| matches!(e, OsrEvent::Frame))
        })?;
        let frame = runtime.frame(1).ok_or("Frame event had no frame")?;
        let pixel = read_bgra_pixel(&frame, frame.get_width() / 2, frame.get_height() / 2)?;
        if pixel != [140, 80, 20, 255] {
            return Err(format!("centre BGRA mismatch: {pixel:?}").into());
        }
        println!(
            "first Frame: {}x{}, centre BGRA {pixel:?}, {} ms",
            frame.get_width(),
            frame.get_height(),
            start.elapsed().as_millis()
        );
        drop(frame);
        // A finished first load is necessary for a committed back-history entry.
        wait(runtime, requests, || {
            sink.events
                .borrow()
                .iter()
                .any(|e| matches!(e, OsrEvent::Loading(false)))
        })?;
        sink.events.borrow_mut().clear();
        runtime.navigate(1, SECOND);
        wait(runtime, requests, || {
            let events = sink.events.borrow();
            events
                .iter()
                .any(|e| matches!(e, OsrEvent::Url(url) if url == SECOND))
                && events
                    .iter()
                    .any(|e| matches!(e, OsrEvent::Title(title) if title == "OSR second"))
                && events
                    .iter()
                    .any(|e| matches!(e, OsrEvent::History { can_back: true, .. }))
        })?;
        // A repaint into the existing frame.
        wait(runtime, requests, || {
            runtime.frame(1).is_some_and(|f| {
                read_bgra_pixel(&f, f.get_width() / 2, f.get_height() / 2)
                    .is_ok_and(|p| p == [20, 80, 140, 255])
            })
        })?;
        println!(
            "second navigation: Url({SECOND}), Title(OSR second), History(can_back=true), centre BGRA [20, 80, 140, 255]"
        );
        Ok(())
    }
    #[cfg(target_os = "macos")]
    fn locations() -> Result<(PathBuf, PathBuf, &'static str), Box<dyn Error>> {
        let exe = std::env::current_exe()?;
        let contents = exe
            .parent()
            .and_then(|p| p.parent())
            .ok_or("missing bundle Contents")?;
        let frameworks = contents.join("Frameworks");
        Ok((
            frameworks.join("Chromium Embedded Framework.framework"),
            frameworks.join("butler-cef-host Helper.app/Contents/MacOS/butler-cef-host Helper"),
            "Macintosh; Intel Mac OS X 10_15_7",
        ))
    }
    #[cfg(target_os = "linux")]
    fn locations() -> Result<(PathBuf, PathBuf, &'static str), Box<dyn Error>> {
        let exe = std::env::current_exe()?;
        let dir = exe.parent().ok_or("missing executable directory")?;
        Ok((
            dir.to_path_buf(),
            dir.join("butler-cef-host"),
            "X11; Linux x86_64",
        ))
    }
    #[cfg(windows)]
    fn locations() -> Result<(PathBuf, PathBuf, &'static str), Box<dyn Error>> {
        let exe = std::env::current_exe()?;
        let dir = exe.parent().ok_or("missing executable directory")?;
        Ok((
            dir.to_path_buf(),
            dir.join("butler_cef_host.exe"),
            "Windows NT 10.0; Win64; x64",
        ))
    }
    #[cfg(not(windows))]
    fn remove_profile(profile: &std::path::Path) -> std::io::Result<()> {
        std::fs::remove_dir_all(profile)
    }
    /// Chromium's logging keeps this process's handle to cef.log open until exit, and Windows
    /// cannot delete an open file; the caller removes that one file and the directory.
    #[cfg(windows)]
    fn remove_profile(profile: &std::path::Path) -> std::io::Result<()> {
        for entry in std::fs::read_dir(profile)? {
            let path = entry?.path();
            if path.is_dir() {
                std::fs::remove_dir_all(&path)?;
            } else if path.file_name() != Some("cef.log".as_ref()) {
                std::fs::remove_file(&path)?;
            }
        }
        println!(
            "profile removed except cef.log (open until exit): {}",
            profile.display()
        );
        Ok(())
    }
    pub(super) fn run() -> Result<(), Box<dyn Error>> {
        let (framework_dir, helper_path, platform) = locations()?;
        let profile: PathBuf =
            std::env::temp_dir().join(format!("butler-osr-smoke-{}", std::process::id()));
        std::fs::create_dir(&profile)?;
        let sink = Rc::new(Sink::default());
        let (tx, requests) = mpsc::channel();
        let runtime = OsrRuntime::start(
            OsrConfig {
                framework_dir,
                helper_path,
                profile_dir: profile.clone(),
                locale: "en-US".into(),
                user_agent: format!(
                    "Mozilla/5.0 ({platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.{}.{}.{} Safari/537.36 Butler/1",
                    cef::sys::CHROME_VERSION_MAJOR,
                    cef::sys::CHROME_VERSION_MINOR,
                    cef::sys::CHROME_VERSION_BUILD,
                    cef::sys::CHROME_VERSION_PATCH,
                ),
            },
            sink.clone(),
            Arc::new(move |delay| {
                let _ = tx.send(delay);
            }),
            Rc::new(|_| {
                butler_cef_host::osr::PopupDecision::Block(
                    butler_cef_host::osr::PopupBlock::NoGesture,
                )
            }),
            Rc::new(|_| butler_cef_host::osr::DownloadDecision::Dialog),
        )?;
        let result = verify(&runtime, &sink, &requests);
        runtime.shutdown();
        remove_profile(&profile)?;
        result?;
        println!("OSR smoke: PASS; shutdown complete");
        Ok(())
    }
}
#[cfg(cef_osr)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    smoke::run()
}
#[cfg(not(cef_osr))]
fn main() {
    eprintln!("osr_smoke requires macOS, Windows or Linux");
    std::process::exit(1);
}
