//! The App's quit: close every page, then shut CEF down.
use super::OsrRuntime;
use std::time::{Duration, Instant};

impl OsrRuntime {
    /// The App's quit ends the process without dropping this, and Chromium writes cookies and
    /// site storage only at shutdown or on a delay, so the quit hook calls it.
    pub fn shutdown(&self) {
        if self.shut.replace(true) {
            return;
        }
        let pages: Vec<_> = self.state.pages.borrow().keys().copied().collect();
        for page in pages {
            self.close(page);
        }
        // CEF requires every on_before_close before shutdown. Only pump during this teardown.
        let deadline = Instant::now() + Duration::from_secs(3);
        while !self.state.pages.borrow().is_empty() && Instant::now() < deadline {
            cef::do_message_loop_work();
            std::thread::sleep(Duration::from_millis(5));
        }
        if !self.state.pages.borrow().is_empty() {
            eprintln!("butler-cef: pages did not close within 3 s; CEF not shut down");
            return;
        }
        cef::shutdown();
        #[cfg(windows)]
        super::d3d::release_device();
    }
}

impl Drop for OsrRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}
