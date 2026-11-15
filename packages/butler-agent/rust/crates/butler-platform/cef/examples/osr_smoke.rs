#[cfg(target_os = "macos")]
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
        runtime.open(1, FIRST, (320, 240), 1.)?;
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
        println!("second navigation: Url({SECOND}), Title(OSR second), History(can_back=true)");
        Ok(())
    }
    pub(super) fn run() -> Result<(), Box<dyn Error>> {
        let exe = std::env::current_exe()?;
        let contents = exe
            .parent()
            .and_then(|p| p.parent())
            .ok_or("missing bundle Contents")?;
        let frameworks = contents.join("Frameworks");
        let profile: PathBuf =
            std::env::temp_dir().join(format!("butler-osr-smoke-{}", std::process::id()));
        std::fs::create_dir(&profile)?;
        let sink = Rc::new(Sink::default());
        let (tx, requests) = mpsc::channel();
        let runtime = OsrRuntime::start(
            OsrConfig {
                framework_dir: frameworks.join("Chromium Embedded Framework.framework"),
                helper_path: frameworks
                    .join("butler-cef-host Helper.app/Contents/MacOS/butler-cef-host Helper"),
                profile_dir: profile.clone(),
                locale: "en-US".into(),
                user_agent: format!(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.{}.{}.{} Safari/537.36 Butler/1",
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
        )?;
        let result = verify(&runtime, &sink, &requests);
        runtime.shutdown();
        std::fs::remove_dir_all(profile)?;
        result?;
        println!("OSR smoke: PASS; shutdown complete");
        Ok(())
    }
}
#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    smoke::run()
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("osr_smoke requires macOS");
    std::process::exit(1);
}
