//! Battery state while the new-chat wallpaper follows power changes.
use std::time::Duration;

use butler_ds::ui::motion;
use butler_platform::power::PowerState;
use gpui::{App, Context, Task, Window};

struct Battery {
    state: PowerState,
    _task: Task<()>,
}

impl Battery {
    fn new(cx: &mut Context<Self>) -> Self {
        let state = butler_platform::power::read();
        let task = cx.spawn(async move |weak, cx| {
            loop {
                motion::sleep(cx.background_executor(), Duration::from_secs(5)).await;
                let power = cx
                    .background_executor()
                    .spawn(async { butler_platform::power::read() })
                    .await;
                if weak
                    .update(cx, |state, cx| {
                        if state.state != power {
                            state.state = power;
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    return;
                }
            }
        });
        Self { state, _task: task }
    }
}

/// Electron's power source is event-driven; the OS notifications need `unsafe`, which the
/// workspace forbids, so this polls while it is read.
pub(in crate::ui::chat) fn state(window: &mut Window, cx: &mut App) -> PowerState {
    window
        .use_keyed_state("wallpaper-on-battery", cx, |_, cx| Battery::new(cx))
        .read(cx)
        .state
}
