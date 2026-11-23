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
        io::Write,
        path::PathBuf,
        rc::Rc,
        sync::{
            Arc,
            mpsc::{self, Receiver, RecvTimeoutError},
        },
        time::{Duration, Instant},
    };

    /// What a `--kill-check` child prints once it has a frame, its helpers and its job.
    const READY: &str = "kill-check ready";
    /// Every helper that carries our job's name is in it, or was already in another job; the job
    /// kills on close (`crate::job`).
    #[cfg(windows)]
    #[allow(unsafe_code, reason = "process and job queries; see SAFETY comments")]
    mod in_job {
        use std::{
            error::Error,
            ffi::c_void,
            io::BufRead,
            os::windows::io::AsRawHandle,
            time::{Duration, Instant},
        };
        use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
        use windows::Win32::System::JobObjects::{
            IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            OpenJobObjectW, QueryInformationJobObject,
        };
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, WaitForSingleObject,
        };
        use windows::core::{BOOL, HSTRING};
        /// `JOB_OBJECT_QUERY` (winnt.h).
        const JOB_OBJECT_QUERY: u32 = 0x4;

        /// The `(pid, command line)` of the `butler_cef_host.exe` processes whose `--{switch}=` value
        /// (quoted or not) is `value`.
        fn helpers(switch: &str, value: &str) -> Result<Vec<(u32, String)>, Box<dyn Error>> {
            // `Stop`: a failed query must fail the process, not print nothing.
            let script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter \"Name='butler_cef_host.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }";
            let list = std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", script])
                .output()?;
            if !list.status.success() {
                return Err(format!(
                    "helper query failed: {}",
                    String::from_utf8_lossy(&list.stderr)
                )
                .into());
            }
            let prefix = format!("--{switch}=");
            Ok(String::from_utf8_lossy(&list.stdout)
                .lines()
                .filter_map(|line| {
                    let (pid, cmd) = line.split_once(' ')?;
                    let token = cmd.split(prefix.as_str()).nth(1)?.trim_start_matches('"');
                    (token.split(['"', ' ']).next()? == value)
                        .then(|| Some((pid.parse().ok()?, cmd.to_owned())))
                        .flatten()
                })
                .collect())
        }
        /// Kills the child on every path out of `kill_check`.
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        /// Kills a child App (`--hold`) once it printed `READY` and has helpers, then times how long
        /// until the App is gone and until no helper names it in `--butler-osr-app` (5 s deadline).
        /// A helper query is a PowerShell start (~0.4 s): the zero time has that resolution, and a
        /// failed query is an error, never "zero".
        pub(super) fn kill_check() -> Result<(), Box<dyn Error>> {
            let mut app = Child(
                std::process::Command::new(std::env::current_exe()?)
                    .args(["--hold", "60"])
                    .stdout(std::process::Stdio::piped())
                    .spawn()?,
            );
            let (pid, switch) = (app.0.id().to_string(), butler_cef_host::switches::OSR_APP);
            let mut out = std::io::BufReader::new(app.0.stdout.take().ok_or("no stdout")?);
            let mut line = String::new();
            while line.trim() != super::READY {
                line.clear();
                if out.read_line(&mut line)? == 0 {
                    return Err("the child App exited before it was ready".into());
                }
            }
            if helpers(switch, &pid)?.is_empty() {
                return Err("the child App has no helpers before the kill".into());
            }
            let kill = Instant::now();
            app.0.kill()?; // TerminateProcess on the handle we hold
            // SAFETY: the handle belongs to `app`, which outlives the call.
            let waited = unsafe { WaitForSingleObject(HANDLE(app.0.as_raw_handle()), 5000) };
            if waited != WAIT_OBJECT_0 {
                return Err("the child App was still alive 5 s after TerminateProcess".into());
            }
            let gone = kill.elapsed();
            let left = loop {
                let left = helpers(switch, &pid)?;
                if left.is_empty() || kill.elapsed() >= Duration::from_secs(5) {
                    break left;
                }
                std::thread::sleep(Duration::from_millis(50));
            };
            let zero = kill.elapsed();
            let _ = std::fs::remove_dir_all(
                std::env::temp_dir().join(format!("butler-osr-smoke-{pid}")),
            );
            if !left.is_empty() {
                return Err(format!("helpers left after 5 s: {left:?}").into());
            }
            println!(
                "kill-check: App gone {} ms, zero helpers {} ms",
                gone.as_millis(),
                zero.as_millis()
            );
            Ok(())
        }
        /// Closes the job handle on every path.
        struct Job(HANDLE);
        impl Drop for Job {
            fn drop(&mut self) {
                // SAFETY: the handle is owned by this guard and closed once.
                let _ = unsafe { CloseHandle(self.0) };
            }
        }
        /// `IsProcessInJob` of the process: in `job`, or (no job) in any job. `None`: the process
        /// exited (it cannot be opened).
        fn in_job(pid: u32, job: Option<HANDLE>) -> Result<Option<bool>, Box<dyn Error>> {
            // SAFETY: the handle is closed below.
            let Ok(process) =
                (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
            else {
                return Ok(None);
            };
            let mut inside = BOOL(0);
            // SAFETY: `inside` outlives the call.
            let result = unsafe { IsProcessInJob(process, job, &raw mut inside) };
            // SAFETY: closing the handle opened above, once.
            let _ = unsafe { CloseHandle(process) };
            result?;
            Ok(Some(inside.as_bool()))
        }
        pub(super) fn check(name: &str) -> Result<(), Box<dyn Error>> {
            // SAFETY: the name is a valid HSTRING.
            let job =
                Job(unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, false, &HSTRING::from(name)) }?);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            // SAFETY: `limits` is the struct the information class names, with its size.
            unsafe {
                QueryInformationJobObject(
                    Some(job.0),
                    JobObjectExtendedLimitInformation,
                    (&raw mut limits).cast::<c_void>(),
                    u32::try_from(size_of_val(&limits))?,
                    None,
                )
            }?;
            if limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                == Default::default()
            {
                return Err("the job does not kill on close".into());
            }
            let (mut ours, mut other) = (0, 0);
            for (pid, _) in helpers(butler_cef_host::switches::OSR_JOB, name)? {
                match in_job(pid, Some(job.0))? {
                    None => {}
                    Some(true) => ours += 1,
                    // Already in another job (Chromium's) before ours.
                    Some(false) => match in_job(pid, None)? {
                        Some(false) => return Err(format!("helper {pid} is in no job").into()),
                        Some(true) => other += 1,
                        None => {}
                    },
                }
            }
            if ours == 0 {
                return Err("no helper in our job".into());
            }
            println!(
                "in-job: {ours} helpers in {name} (kill-on-close), {other} already in another job"
            );
            Ok(())
        }
    }
    const LIMIT: Duration = Duration::from_secs(30);
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
        limit: Duration,
        ready: impl Fn() -> bool,
    ) -> Result<(), Box<dyn Error>> {
        let end = Instant::now() + limit;
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
        hold: Option<u64>,
    ) -> Result<(), Box<dyn Error>> {
        let start = Instant::now();
        runtime.open(
            1,
            FIRST,
            (320, 240),
            1.,
            60,
            butler_cef_host::osr::OsrProfile::SignedIn,
        )?;
        // CEF can deliver a transparent first paint before the page body paints.
        let last = std::cell::Cell::new(None);
        wait(runtime, requests, LIMIT, || {
            runtime.next_frame(1).is_some_and(|f| {
                let pixel = read_bgra_pixel(&f, f.get_width() / 2, f.get_height() / 2).ok();
                last.set(pixel);
                pixel == Some([140, 80, 20, 255])
            })
        })
        .map_err(|e| format!("{e}; last centre BGRA {:?}", last.get()))?;
        let frame = runtime.next_frame(1).ok_or("Frame event had no frame")?;
        let pixel = read_bgra_pixel(&frame, frame.get_width() / 2, frame.get_height() / 2)?;
        println!(
            "first Frame: {}x{}, centre BGRA {pixel:?}, {} ms",
            frame.get_width(),
            frame.get_height(),
            start.elapsed().as_millis()
        );
        drop(frame);
        #[cfg(windows)]
        in_job::check(runtime.child_job_name().ok_or("no helper job")?)?;
        if let Some(secs) = hold {
            // `--kill-check` child: keep pumping until the parent kills this App.
            println!("{READY}");
            std::io::stdout().flush()?;
            let (limit, end) = (
                Duration::from_secs(secs),
                Instant::now() + Duration::from_secs(secs),
            );
            return wait(runtime, requests, limit, || Instant::now() >= end);
        }
        // A finished first load is necessary for a committed back-history entry.
        wait(runtime, requests, LIMIT, || {
            sink.events
                .borrow()
                .iter()
                .any(|e| matches!(e, OsrEvent::Loading(false)))
        })?;
        sink.events.borrow_mut().clear();
        runtime.navigate(1, SECOND);
        wait(runtime, requests, LIMIT, || {
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
        wait(runtime, requests, LIMIT, || {
            runtime.next_frame(1).is_some_and(|f| {
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
        let args: Vec<String> = std::env::args().collect();
        #[cfg(windows)]
        if args.get(1).map(String::as_str) == Some("--kill-check") {
            return in_job::kill_check();
        }
        let hold = args
            .iter()
            .position(|a| a == "--hold")
            .and_then(|i| args.get(i + 1)?.parse().ok());
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
                // The consumer is `read_bgra_pixel`, which uses the copy device's adapter.
                adapter_luid: None,
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
        let result = verify(&runtime, &sink, &requests, hold);
        runtime.shutdown();
        remove_profile(&profile)?;
        result?;
        println!("OSR smoke: PASS; shutdown complete");
        Ok(())
    }
}
#[cfg(cef_osr)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    butler_cef_host::shorten_temp_path();
    smoke::run()
}
#[cfg(not(cef_osr))]
fn main() {
    eprintln!("osr_smoke requires macOS, Windows or Linux");
    std::process::exit(1);
}
