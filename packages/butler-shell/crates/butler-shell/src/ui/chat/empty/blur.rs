//! Window blur levels used by the resting print.
use std::time::{Duration, Instant};

use butler_ds::ui::motion;
use gpui::{App, Task, Window};

// RISO_BLUR_SLOW_MS
const BLUR_SLOW: Duration = Duration::from_mins(2);
// RISO_BLUR_FREEZE_MS
const BLUR_FREEZE: Duration = Duration::from_mins(10);

struct Away {
    since: Option<Instant>,
    wake: Option<Task<()>>,
}

pub(in crate::ui::chat) fn level(window: &mut Window, cx: &mut App) -> u8 {
    let away = window.use_keyed_state("wallpaper-blur", cx, |_, _| Away {
        since: None,
        wake: None,
    });
    let active = window.is_window_active();
    away.update(cx, |away, cx| {
        if active {
            away.since = None;
            away.wake = None;
            return 0;
        }
        let since = *away.since.get_or_insert_with(Instant::now);
        if away.wake.is_none() {
            away.wake = Some(cx.spawn(async move |this, cx| {
                motion::sleep(cx.background_executor(), BLUR_SLOW).await;
                this.update(cx, |_, cx| cx.notify()).ok();
                motion::sleep(
                    cx.background_executor(),
                    BLUR_FREEZE.saturating_sub(BLUR_SLOW),
                )
                .await;
                this.update(cx, |_, cx| cx.notify()).ok();
            }));
        }
        let elapsed = since.elapsed();
        u8::from(elapsed >= BLUR_SLOW) + u8::from(elapsed >= BLUR_FREEZE)
    })
}
