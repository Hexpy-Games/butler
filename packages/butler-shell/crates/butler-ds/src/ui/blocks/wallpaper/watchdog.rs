//! Slow animated frames fall back to a still, then retry after a quiet period.
use std::time::Duration;

use gpui::Context;

// WALLPAPER_WATCHDOG_SLOW_RENDER_MS
pub(super) const SLOW_RENDER: Duration = Duration::from_millis(50);
// WALLPAPER_WATCHDOG_SLOW_FRAMES
pub(super) const SLOW_FRAMES: u32 = 8;
// WALLPAPER_WATCHDOG_RETRY_MS
const RETRY: Duration = Duration::from_secs(30);
// WALLPAPER_WATCHDOG_RETRY_MAX_MS
const RETRY_MAX: Duration = Duration::from_mins(8);

#[derive(Default)]
pub(super) struct Watchdog {
    degraded: bool,
    retries: u32,
    retry: Option<gpui::Task<()>>,
}

impl Watchdog {
    pub(super) fn degraded(&self) -> bool {
        self.degraded
    }

    pub(super) fn degrade(&mut self, cx: &mut Context<Self>) {
        if self.degraded {
            return;
        }
        self.degraded = true;
        cx.notify();
        let quiet = RETRY
            .saturating_mul(2u32.saturating_pow(self.retries))
            .min(RETRY_MAX);
        self.retry = Some(cx.spawn(async move |this, cx| {
            crate::ui::motion::sleep(cx.background_executor(), quiet).await;
            this.update(cx, |w, cx| {
                w.degraded = false;
                w.retries += 1;
                w.retry = None;
                cx.notify();
            })
            .ok();
        }));
    }
}
