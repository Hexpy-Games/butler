//! The resting print crossfades cached keyframes; host changes retain the current mix.
use crate::ui::cover::cover;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use gpui::{
    AnyElement, App, Context, IntoElement as _, LayerMotion, MotionEasing, ParentElement as _,
    Styled as _, Window, canvas, div,
};

use super::{WallpaperHost, live::LiveFrame, live_modules, live_print};

// RISO_SEGMENT_MS
const SEGMENT_MS: f32 = 8000.;
// RISO_STEP_HZ
const STEP_HZ: f32 = 4.;
// RISO_LIVE_CAP_FPS
const LIVE_CAP_FPS: f32 = 30.;
// RISO_SEGMENT_FLOW = RISO_DRIFT_RATE × RISO_SEGMENT_MS / 1000
const SEGMENT_FLOW: f32 = 0.035 * 8.;

#[derive(Clone, Copy, PartialEq, Eq)]
enum DriftHost {
    Full,
    Slow,
    Frozen,
    Still,
}

impl DriftHost {
    fn factor(self) -> f32 {
        match self {
            Self::Full => 1.,
            Self::Slow => 0.5,
            Self::Frozen | Self::Still => 0.,
        }
    }

    fn of(still: bool, host: WallpaperHost) -> Self {
        if still {
            Self::Still
        } else if host.blur >= 2 {
            Self::Frozen
        } else if host.blur == 1 || host.on_battery {
            Self::Slow
        } else {
            Self::Full
        }
    }
}

struct Drift {
    flow: f32,
    a0: f32,
    t0_ms: u32,
    dur_ms: u32,
    host: DriftHost,
    top: bool,
    wake: Option<(u32, gpui::Task<()>)>,
}

impl Drift {
    fn new() -> Self {
        Self {
            flow: 0.,
            a0: 0.,
            t0_ms: 0,
            dur_ms: 0,
            host: DriftHost::Still,
            top: false,
            wake: None,
        }
    }

    fn alpha(&self, now_ms: u32) -> f32 {
        if self.dur_ms == 0 {
            self.a0
        } else {
            self.a0
                + (1. - self.a0)
                    * (now_ms.wrapping_sub(self.t0_ms) as f32 / self.dur_ms as f32).clamp(0., 1.)
        }
    }

    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "segment durations are rounded nonnegative milliseconds"
    )]
    fn advance(&mut self, now_ms: u32, host: DriftHost, cx: &mut Context<Self>) {
        if host != self.host {
            let a = self.alpha(now_ms);
            self.host = host;
            match host {
                DriftHost::Still => {
                    self.flow += a * SEGMENT_FLOW;
                    self.a0 = 0.;
                    self.dur_ms = 0;
                }
                DriftHost::Frozen => {
                    self.a0 = a;
                    self.dur_ms = 0;
                }
                DriftHost::Full | DriftHost::Slow => {
                    self.a0 = a;
                    self.t0_ms = now_ms;
                    self.dur_ms = (SEGMENT_MS / host.factor() * (1. - a)).round() as u32;
                }
            }
        }
        while self.dur_ms > 0 && now_ms.wrapping_sub(self.t0_ms) >= self.dur_ms {
            let segment = (SEGMENT_MS / host.factor()).round() as u32;
            self.flow += SEGMENT_FLOW;
            self.top = !self.top;
            self.a0 = 0.;
            self.t0_ms = self.t0_ms.wrapping_add(self.dur_ms);
            if now_ms.wrapping_sub(self.t0_ms) >= segment {
                self.t0_ms = now_ms;
            }
            self.dur_ms = segment;
        }
        match host {
            DriftHost::Full | DriftHost::Slow => {
                let end = self.t0_ms.wrapping_add(self.dur_ms);
                if self.wake.as_ref().is_none_or(|(armed, _)| *armed != end) {
                    self.wake = Some((
                        end,
                        cx.spawn(async move |this, cx| {
                            crate::ui::motion::sleep(
                                cx.background_executor(),
                                Duration::from_millis(end.wrapping_sub(now_ms).into()),
                            )
                            .await;
                            this.update(cx, |_, cx| cx.notify()).ok();
                        }),
                    ));
                }
            }
            DriftHost::Frozen | DriftHost::Still => self.wake = None,
        }
    }

    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "opacity steps are rounded nonnegative counts"
    )]
    fn steps(&self) -> u32 {
        let step_ms = 1000. / LIVE_CAP_FPS.min(STEP_HZ * self.host.factor());
        ((self.dur_ms as f32 / step_ms).round() as u32).max(1)
    }
}

pub(super) fn layer(
    key: u64,
    params: [f32; 4],
    frame: LiveFrame,
    module: &'static live_modules::Module,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let drift = window.use_keyed_state(("wallpaper-drift", key), cx, |_, _| Drift::new());
    drift.update(cx, |d, cx| {
        d.advance(
            gpui::animation_time_ms(),
            DriftHost::of(!frame.animate || frame.host.constrained, frame.host),
            cx,
        );
    });
    let d = drift.read(cx);
    let slot_key = |top: bool| {
        let mut hash = DefaultHasher::new();
        (key, top).hash(&mut hash);
        hash.finish()
    };
    let print = |slot_key, flow| {
        canvas(
            |_, _, _| (),
            move |bounds, (), window, _| {
                live_print::paint(bounds, slot_key, params, frame, flow, module, window);
            },
        )
        .size_full()
    };
    let layer = div()
        .relative()
        .size_full()
        .child(print(slot_key(d.top), d.flow));
    if d.host == DriftHost::Still {
        return layer.into_any_element();
    }
    let top = cover().child(print(slot_key(!d.top), d.flow + SEGMENT_FLOW));
    let top = match d.host {
        DriftHost::Full | DriftHost::Slow => top.motion(LayerMotion {
            start_ms: d.t0_ms,
            duration_ms: d.dur_ms,
            easing: MotionEasing::Steps(d.steps()),
            opacity: (d.a0, 1.),
            ..LayerMotion::NONE
        }),
        DriftHost::Frozen | DriftHost::Still => top.opacity(d.a0),
    };
    layer.child(top).into_any_element()
}
