use gpui::{App, Window, px};

use super::super::frame::clamp_chat_width;
use super::super::split::shared_room;
use super::{AdaptiveShell, Ctx, Tracks};
use crate::tokens::{Duration as DsDuration, Easing, Length};
use crate::ui::blocks::scope;
use crate::ui::context::Ds;
use crate::ui::motion::{Props, Timing};

/// The docked sidebar's track width (useSidebarTrackMotion.ts): closing commits 0 at once; opening
/// keeps 0 while the sidebar and the workspace slide aside, and commits when the motion ends.
pub(super) fn left_track(shell: &AdaptiveShell, t: &Tracks, left_w: f32, ds: &Ds) -> f32 {
    let timing = Timing::token(
        ds,
        DsDuration::AdaptivePanelDuration,
        Easing::AdaptivePanelEasing,
    );
    if shell.left_open && !t.left.moving(&timing) {
        left_w
    } else {
        0.
    }
}

/// The width of the split's room: the window less the root padding, the docked tracks and the
/// workspace's edges (the drawer layout has no tracks).
pub(super) fn split_room(shell: &AdaptiveShell, ctx: &Ctx, ds: &Ds) -> f32 {
    let (left, right) = if ctx.drawer {
        (0., 0.)
    } else {
        (
            left_track(shell, &ctx.t, ctx.left_w, ds),
            ctx.t.right.target() * ctx.right_w,
        )
    };
    let (border_l, border_r, pad_l, pad_r) = workspace_edges(ctx, left, ds);
    shell.window.width - 2. * ctx.inset - left - right - border_l - border_r - pad_l - pad_r
}

/// The split with its room and the chat column's on-screen width while the pane moves: from the
/// width on screen when the motion (or its reversal) started, on the pane motion's eased fraction.
pub(super) fn split_with_room(
    shell: &AdaptiveShell,
    s: scope::SplitMotion,
    (room, cards): (f32, bool),
    window: &mut Window,
    cx: &mut App,
) -> scope::SplitMotion {
    let ds = Ds::get(cx);
    let timing = Timing::token(
        ds,
        DsDuration::AdaptivePanelDuration,
        Easing::AdaptivePanelEasing,
    );
    let moving = room > 0. && s.motion.is_some_and(|m| m.moving(&timing));
    let target = if s.open {
        clamp_chat_width(s.chat_width, shared_room(room, cards, ds))
    } else {
        room
    };
    // The width on screen when this segment of the pane motion started, then the pane's own eased
    // fraction toward the target: the chat edge and the pane move on one clock and end together.
    let state = window.use_keyed_state((shell.id.clone(), "split-chat-from"), cx, |_, _| {
        (s.open, target, target)
    });
    let (was_open, from, last) = *state.read(cx);
    let from = if was_open == s.open { from } else { last };
    let chat_now = s
        .motion
        .filter(|_| moving)
        .map(|m| from + (target - from) * m.eased(&timing));
    state.update(cx, |v, _| *v = (s.open, from, chat_now.unwrap_or(target)));
    scope::SplitMotion {
        chat_now,
        room,
        ..s
    }
}

/// The workspace slides with the docked sidebar while its track is held (useSidebarTrackMotion.ts):
/// one offset on the sidebar's own transition, which retargets from where it is.
pub(super) fn slide_with_sidebar(
    cell: gpui::Stateful<gpui::Div>,
    t: &Tracks,
    left_w: f32,
    timing: &Timing,
) -> gpui::Stateful<gpui::Div> {
    if !t.left.moving(timing) {
        return cell;
    }
    t.left.apply(
        cell,
        timing,
        &Props {
            offset: Some((gpui::point(px(0.), px(0.)), gpui::point(px(left_w), px(0.)))),
            ..Default::default()
        },
    )
}

/// The workspace's left and right border, then its left and right padding (the cards frame's room
/// for cards): what its content box loses to the left and right.
pub(super) fn workspace_edges(ctx: &Ctx, left_track: f32, ds: &Ds) -> (f32, f32, f32, f32) {
    let hairline = f32::from(ds.len(Length::BorderHairline));
    let border = if ctx.borderless { 0. } else { hairline };
    let border_r = if ctx.inspector_open && !ctx.cards {
        0.
    } else {
        border
    };
    let inset = f32::from(ds.len(Length::ShellCardInset)) - hairline;
    let (pad_l, pad_r) = match (ctx.cards, left_track > 0.) {
        (false, _) => (0., 0.),
        (true, true) => (0., inset),
        (true, false) => (inset, inset),
    };
    (border, border_r, pad_l, pad_r)
}
