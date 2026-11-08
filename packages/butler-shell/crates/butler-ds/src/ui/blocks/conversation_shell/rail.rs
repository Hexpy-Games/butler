//! The rail slot (conversationRail.tsx): whether the column makes room for a tab rail, and
//! whether the rail waits for the aside. The rail reserves room while it shows a tab and, once it
//! has in a view, for the rest of that view, so cards that come and go never move the column back
//! and forth. The rail and the aside share the right margin: the rail stays hidden while the
//! aside shows and until its exit has ended, then fades in.
use std::time::{Duration, Instant};

use gpui::{App, ElementId, SharedString, Window};

use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::blocks::anim::ramp;
use crate::ui::context::Ds;
use crate::ui::motion::Timing;

#[derive(Default)]
struct Latch {
    view: Option<SharedString>,
    /// The rail was held at some point (so it fades in when released).
    was_held: bool,
    /// The aside showed last frame.
    aside_shown: bool,
    /// When the aside last went: its exit fade runs from then.
    left_at: Option<Instant>,
}

/// How long the aside takes to leave (its fade and a frame to spare).
const EXIT_WINDOW: Duration = Duration::from_millis(240);

/// What the rail slot does this frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Rail {
    /// The column makes room for the rail.
    pub(super) reserved: bool,
    /// Hidden and inert while the aside shows or leaves.
    pub(super) held: bool,
    /// The fade-in of a released rail, 0 to 1 (1 when it never was held).
    pub(super) release: f32,
}

/// `view` is the rail's view (a conversation id): the room made for the first tab stays for it.
pub(super) fn rail(
    id: &ElementId,
    (has_rail, showing, view): (bool, bool, Option<&SharedString>),
    aside_shown: bool,
    window: &mut Window,
    cx: &mut App,
) -> Rail {
    let state = window.use_keyed_state((id.clone(), "rail"), cx, |_, _| Latch::default());
    let now = cx.background_executor().now();
    let (reserved, held, was_held, leaving) = state.update(cx, |latch, _| {
        if aside_shown != latch.aside_shown {
            latch.aside_shown = aside_shown;
            latch.left_at = (!aside_shown).then_some(now);
            latch.was_held |= aside_shown;
        }
        let leaving = latch
            .left_at
            .is_some_and(|at| now.saturating_duration_since(at) < EXIT_WINDOW);
        let held = aside_shown || leaving;
        // Room for the rail: none while the aside shows, else while it shows a tab or has in this view.
        let wants = has_rail && !aside_shown;
        if showing && wants && view.is_some() && latch.view.as_ref() != view {
            latch.view = view.cloned();
        }
        if !wants {
            latch.view = None;
        }
        let reserved = wants && (showing || (view.is_some() && latch.view.as_ref() == view));
        (reserved, held, latch.was_held, leaving)
    });
    if leaving {
        window.request_animation_frame();
    }
    let ds = Ds::get(cx);
    let timing = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseDecelerate);
    let target = f32::from(u8::from(!held));
    let release = if was_held {
        ramp(
            (id.clone(), "rail-release"),
            (target, held),
            &timing,
            window,
            cx,
        )
    } else {
        1.
    };
    Rail {
        reserved,
        held,
        release,
    }
}
