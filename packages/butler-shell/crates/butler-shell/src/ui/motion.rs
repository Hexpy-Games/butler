//! Butler motion tokens (tokens.css "Linear-crisp" scale) on gpui animations.
use butler_ds::tokens::{Duration as DsDuration, TokenContext};
use butler_ds::ui::convert;

use gpui::{Hsla, Rgba, SharedString, SpringAnimation, SpringConfig};

/// CSS cubic-bezier(x1, y1, x2, y2) solved for y at progress x.
pub(crate) fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32) -> impl Fn(f32) -> f32 + Clone {
    move |x| convert::cubic_bezier(x1, y1, x2, y2, x)
}

/// Critically damped springs whose 99% settle time matches a duration token. They keep
/// velocity when a hover reverses mid-way, which a restarted keyframe would not.
fn critical(settle_ms: f32) -> SpringConfig {
    let omega = 6.64 / (settle_ms / 1000.);
    SpringConfig::new(omega * omega, 2. * omega, 1.)
}

pub(crate) fn spring_fast(on: bool) -> SpringAnimation<f32> {
    SpringAnimation::new(critical(
        TokenContext::DEFAULT.duration(DsDuration::MotionFast),
    ))
    .to(if on { 1. } else { 0. })
    .with_epsilon(0.004)
}

pub(crate) fn mix(a: Hsla, b: Hsla, t: f32) -> Hsla {
    let (a, b) = (gpui::hsla_to_rgba(a), gpui::hsla_to_rgba(b));
    let l = |x: f32, y: f32| x + (y - x) * t;
    gpui::rgb_to_hsla(Rgba::new(
        l(a.red, b.red),
        l(a.green, b.green),
        l(a.blue, b.blue),
        l(a.alpha, b.alpha),
    ))
}

/// Which element of an entity the pointer is over; drives the spring hover fades.
#[derive(Default)]
pub(crate) struct Hover(Option<SharedString>);

impl Hover {
    pub(crate) fn is(&self, key: &str) -> bool {
        self.0.as_deref() == Some(key)
    }

    /// Returns true when the hovered element changed.
    pub(crate) fn set(&mut self, key: &SharedString, on: bool) -> bool {
        if on {
            if self.0.as_ref() == Some(key) {
                return false;
            }
            self.0 = Some(key.clone());
            true
        } else if self.0.as_ref() == Some(key) {
            self.0 = None;
            true
        } else {
            false
        }
    }
}
