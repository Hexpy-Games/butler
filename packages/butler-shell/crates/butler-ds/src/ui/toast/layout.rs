//! Where a toast is and how it moves: the stack of sonner's stylesheet (`data-expanded`,
//! `data-front`, `data-removed`, `data-visible`) turned into target values, and the CSS
//! transitions between them (Toast.module.css). The `scale` of a collapsed toast behind the front
//! one is gpui's element scale about its centre.
use gpui::{App, Window};
use std::time::Duration;

use super::state::Item;
use crate::tokens::{Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;

use crate::tokens::Ease;
use crate::ui::motion::{Timing, Transition, transition};

/// The gap between toasts (`gap={8}` of Toaster.tsx).
pub(super) const GAP: f32 = 8.; // DS: Toaster.tsx:19
/// `VISIBLE_TOASTS_AMOUNT`.
pub(super) const VISIBLE: usize = 3;
/// Each toast behind the front one is this much smaller (`0.05`).
const SHRINK: f32 = 0.05;

/// The values one toast is drawn with.
pub(super) struct Anim;

/// What the stack decides about one toast this frame.
pub(super) struct Frame {
    pub index: usize,
    pub front_height: f32,
    pub offset: f32,
    pub expanded: bool,
}

/// A toast's drawn state.
pub(super) struct Resolved {
    pub y: Transition,
    pub scale: Transition,
    pub opacity: Transition,
    pub content: Transition,
    pub swipe: Transition,
    pub height: f32,
    pub timing: Timing,
    pub fade: Timing,
    pub content_time: Timing,
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

/// The transform timing and the independent opacity timing.
fn timing(item: &Item, frame: &Frame, ds: &Ds) -> (Timing, Timing) {
    let leaving = item.removed_at.is_some();
    let css = Ease::Bezier([0.25, 0.1, 0.25, 1.]);
    let motion = if item.swipe_out && !ds.reduced_motion() {
        Timing {
            duration: Duration::from_millis(200),
            ease: Ease::Bezier([0., 0., 0.58, 1.]),
        }
    } else if leaving && frame.index != 0 && !frame.expanded {
        Timing {
            duration: Duration::from_millis(500),
            ease: css,
        }
    } else if leaving {
        Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseExit)
    } else {
        Timing::token(ds, DsDuration::MotionEnterOverlay, Easing::MotionEaseEnter)
    };
    let fade = if ds.reduced_motion() {
        Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard)
    } else if leaving && frame.index != 0 && !frame.expanded && !item.swipe_out {
        Timing {
            duration: Duration::from_millis(200),
            ease: css,
        }
    } else {
        motion
    };
    (motion, fade)
}

/// Retargets each retained toast layer; no host animation frames are requested.
pub(super) fn resolve(
    item: &mut Item,
    frame: &Frame,
    window: &mut Window,
    cx: &mut App,
) -> Resolved {
    let ds = Ds::get(cx);
    let target = target(item, frame, ds);
    let (timing, fade) = timing(item, frame, ds);
    let content_time = Timing {
        duration: Duration::from_millis(400),
        ease: Ease::Bezier([0.25, 0.1, 0.25, 1.]),
    };
    let reduced = ds.reduced_motion();
    let from = -f32::from(ds.len(Length::MotionDistanceLg));
    let height = if !frame.expanded && frame.index != 0 {
        frame.front_height
    } else {
        item.height.get()
    };
    let id = format!("toast-{}", item.id);
    let before = window.use_keyed_state(
        (gpui::ElementId::from(id.clone()), "region-target"),
        cx,
        |_, _| (target.y, target.scale, height),
    );
    if *before.read(cx) != (target.y, target.scale, height) {
        window.animate_layout(timing.ms());
        before.update(cx, |value, _| *value = (target.y, target.scale, height));
    }
    let mut value = |name: &'static str, target: f32, jump: bool, time: &Timing| {
        transition(
            (gpui::ElementId::from(id.clone()), name),
            (target, jump),
            time,
            window,
            cx,
        )
    };
    if item.anim.is_none() {
        value("y", from, true, &timing);
        value("scale", target.scale, true, &timing);
        value("opacity", 0., true, &fade);
        value("content", target.content, true, &content_time);
        value("swipe", 0., true, &timing);
        item.anim = Some(Anim);
    }
    Resolved {
        y: value("y", target.y, reduced, &timing),
        scale: value("scale", target.scale, reduced, &timing),
        opacity: value("opacity", target.opacity, false, &fade),
        content: value("content", target.content, reduced, &content_time),
        swipe: value("swipe", target.swipe, item.swiping || reduced, &timing),
        height,
        timing,
        fade,
        content_time,
    }
}
