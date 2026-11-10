//! How long the scrollbar stays after the content last moved, and the one wake that hides it.
use std::time::{Duration, Instant};

use gpui::{App, Task, Window};

/// The scrollbar stays this long after the content last moved.
const LINGER: Duration = Duration::from_millis(700);

/// The wake that ends the current linger, armed for the move that started it.
#[derive(Default)]
pub(super) struct Linger(Option<(Instant, Task<()>)>);

impl Linger {
    /// Whether the scrollbar still shows. Hiding it needs one frame at the linger end, not a
    /// frame per frame until then; a later move re-arms the wake, and replacing the task cancels
    /// the earlier one.
    pub(super) fn update(
        &mut self,
        scrolled_at: Option<Instant>,
        now: Instant,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        let Some(at) = scrolled_at else {
            return false;
        };
        let left = LINGER.saturating_sub(now.saturating_duration_since(at));
        if left.is_zero() {
            return false;
        }
        if self.0.as_ref().is_none_or(|(armed, _)| *armed != at) {
            self.0 = Some((at, crate::ui::motion::wake_task(window, cx, left)));
        }
        true
    }
}
