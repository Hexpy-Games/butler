//! Where a toast is and how it moves: the stack of sonner's stylesheet (`data-expanded`,
//! `data-front`, `data-removed`, `data-visible`) turned into target values, and the CSS
//! transitions between them (Toast.module.css). The `scale` of a collapsed toast behind the front
//! one is gpui's element scale about its centre.
use std::time::{Duration, Instant};

use super::state::Item;
use crate::tokens::{Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::motion::Ramp;

/// The gap between toasts (`gap={8}` of Toaster.tsx).
pub(super) const GAP: f32 = 8.; // DS: Toaster.tsx:19
/// `VISIBLE_TOASTS_AMOUNT`.
pub(super) const VISIBLE: usize = 3;
/// Each toast behind the front one is this much smaller (`0.05`).
const SHRINK: f32 = 0.05;

/// The values one toast is drawn with.
pub(super) struct Anim {
    y: Ramp,
    scale: Ramp,
    opacity: Ramp,
    content: Ramp,
    swipe: Ramp,
}

/// What the stack decides about one toast this frame.
pub(super) struct Frame {
    pub index: usize,
    pub front_height: f32,
    pub offset: f32,
    pub expanded: bool,
}

/// A toast's drawn state.
pub(super) struct Resolved {
    pub y: f32,
    pub scale: f32,
    pub opacity: f32,
    pub content: f32,
    pub swipe: f32,
    /// The box height before scaling.
    pub height: f32,
    pub moving: bool,
}

/// The state a toast heads for.
struct Target {
    y: f32,
    scale: f32,
    opacity: f32,
    content: f32,
    swipe: f32,
}

fn target(item: &Item, frame: &Frame, ds: &Ds) -> Target {
    let own = item.height.get();
    let front = frame.index == 0;
    let visible = frame.index < VISIBLE;
    let swiped_out = item.swipe_out && !ds.reduced_motion();
    let (mut y, mut scale, mut content) = if frame.expanded {
        (frame.offset, 1., 1.)
    } else if front {
        (0., 1., 1.)
    } else {
        #[expect(clippy::cast_precision_loss, reason = "a stack index")]
        let behind = frame.index as f32;
        (GAP * behind, 1. - SHRINK * behind, 0.)
    };
    let mut opacity = if visible { 1. } else { 0. };
    let mut swipe = item.swipe_y;
    if item.removed_at.is_some() && !item.swipe_out {
        opacity = 0.;
        match (front, frame.expanded) {
            // `translateY(lift * -100%)`.
            (true, _) => y = -own,
            // `translateY(40%)`, without the scale.
            (false, false) => {
                y = 0.4 * frame.front_height;
                scale = 1.;
            }
            (false, true) => y = item.offset_before_remove - own,
        }
        content = 1.;
    } else if swiped_out {
        // `swipe-out-up`: on from where it was let go, a toast's height further, fading.
        swipe = item.swipe_y - own;
        opacity = 0.;
    }
    Target {
        y,
        scale,
        opacity,
        content,
        swipe,
    }
}

/// CSS `ease`.
fn css_ease(x: f32) -> f32 {
    convert::cubic_bezier(0.25, 0.1, 0.25, 1., x)
}

impl Anim {
    /// A toast that has just mounted: `translateY(-distance)` and clear, before it transitions in.
    fn mounting(ds: &Ds, target: &Target) -> Self {
        let from = -f32::from(ds.len(Length::MotionDistanceLg));
        Self {
            y: Ramp::at(from),
            scale: Ramp::at(target.scale),
            opacity: Ramp::at(0.),
            content: Ramp::at(target.content),
            swipe: Ramp::at(0.),
        }
    }
}

/// How a toast's transform and opacity transition this frame: their duration and curve, and the
/// opacity's own duration when it differs.
struct Timing {
    duration: Duration,
    curve: Box<dyn Fn(f32) -> f32>,
    opacity: Option<Duration>,
}

/// The transform and opacity transition: the enter transition, the shorter exit, sonner's 500ms
/// for a toast leaving from behind, and its 200ms swipe-out.
fn timing(item: &Item, frame: &Frame, ds: &Ds) -> Timing {
    let leaving = item.removed_at.is_some();
    let ms = Duration::from_millis;
    if item.swipe_out && !ds.reduced_motion() {
        return Timing {
            duration: ms(200), // DS: sonner styles.css `swipe-out-*`
            curve: Box::new(|x| convert::cubic_bezier(0., 0., 0.58, 1., x)), // CSS `ease-out`
            opacity: None,
        };
    }
    if leaving && frame.index != 0 && !frame.expanded {
        return Timing {
            duration: ms(500), // DS: sonner styles.css, a removed toast behind the front one
            curve: Box::new(css_ease),
            opacity: Some(ms(200)),
        };
    }
    let (duration, ease) = if leaving {
        (DsDuration::MotionExitBase, Easing::MotionEaseExit)
    } else {
        (DsDuration::MotionEnterOverlay, Easing::MotionEaseEnter)
    };
    Timing {
        duration: ds.duration(duration),
        curve: Box::new(convert::easing(ds.tokens().ease(ease))),
        opacity: None,
    }
}

/// Moves the toast's ramps toward this frame's target and reads where they are at `now`.
pub(super) fn resolve(item: &mut Item, frame: &Frame, ds: &Ds, now: Instant) -> Resolved {
    let target = target(item, frame, ds);
    let time = timing(item, frame, ds);
    let reduced = ds.reduced_motion();
    let height = if !frame.expanded && frame.index != 0 {
        frame.front_height
    } else {
        item.height.get()
    };
    let swiping = item.swiping;
    let anim = item.anim.get_or_insert_with(|| Anim::mounting(ds, &target));
    anim.y.retarget(target.y, now, reduced);
    anim.scale.retarget(target.scale, now, reduced);
    anim.opacity.retarget(target.opacity, now, false);
    anim.content.retarget(target.content, now, reduced);
    anim.swipe.retarget(target.swipe, now, swiping || reduced);
    let curve = &*time.curve;
    let (y, m1) = anim.y.sample(now, time.duration, curve);
    let (scale, m2) = anim.scale.sample(now, time.duration, curve);
    // Reduced motion keeps only a fade, over `--motion-fast` on the standard curve.
    let standard = convert::easing(ds.tokens().ease(Easing::MotionEaseStandard));
    let (fade, fade_curve): (_, &dyn Fn(f32) -> f32) = if reduced {
        (ds.duration(DsDuration::MotionFast), &standard)
    } else {
        (time.opacity.unwrap_or(time.duration), curve)
    };
    let (opacity, m3) = anim.opacity.sample(now, fade, fade_curve);
    let (content, m4) = anim
        .content
        .sample(now, Duration::from_millis(400), &css_ease);
    let (swipe, m5) = anim.swipe.sample(now, time.duration, curve);
    Resolved {
        y,
        scale,
        opacity,
        content,
        swipe,
        height,
        moving: m1 || m2 || m3 || m4 || m5,
    }
}
