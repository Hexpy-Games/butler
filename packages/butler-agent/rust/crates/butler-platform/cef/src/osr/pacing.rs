use super::Frame;
use cef::ImplBrowserHost;

impl super::OsrRuntime {
    /// Follows the display: CEF's frame rate is the window's refresh rate.
    pub fn set_frame_rate(&self, page: u64, rate: u32) {
        let Some(p) = self.page(page) else { return };
        if std::mem::replace(&mut p.borrow_mut().rate, rate) == rate {
            return;
        }
        if let Some(h) = self.host(page) {
            h.set_windowless_frame_rate(i32::try_from(rate).unwrap_or(i32::MAX));
        }
    }
    /// One display tick: the oldest queued frame becomes the drawn one.
    pub fn next_frame(&self, page: u64) -> Option<Frame> {
        let p = self.page(page)?;
        let mut p = p.borrow_mut();
        if let Some(f) = p.queue.pop_front() {
            p.frame = Some(f);
        }
        p.frame.clone()
    }
    pub fn queued(&self, page: u64) -> bool {
        self.page(page)
            .is_some_and(|p| !p.borrow().queue.is_empty())
    }
}
