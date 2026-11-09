//! The motion of an AdaptiveShell's panels (useSidebarTrackMotion.ts, useInspectorTrackMotion.ts,
//! AdaptiveShellSplitMotion.ts): each panel, the scrim, the peek card and the split pane ease
//! on the panel tokens (`--adaptive-panel-duration` and `-easing`: slow, emphasized). Reduced
//! motion, a live resize and the settings screen place panels at once; panels then only fade.
use gpui::{App, SharedString, Window};

use super::AdaptiveShell;
use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::blocks::scope::SplitMotion;
use crate::ui::context::Ds;
use crate::ui::motion::{Timing, Transition, transition};

/// Every eased quantity of one frame, each 0 (closed) to 1 (open).
pub(super) struct Tracks {
    pub left: Transition,
    /// The docked sidebar's fade (reduced motion).
    pub left_fade: Transition,
    pub right: Transition,
    pub right_fade: Transition,
    pub scrim: Transition,
    pub peek: Transition,
    pub split: Option<SplitMotion>,
}

/// What the motion depends on besides the shell's inputs.
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent layout facts, as the CSS data attributes of the shell"
)]
pub(super) struct Facts {
    pub drawer: bool,
    pub inspector_open: bool,
    pub peeking: bool,
    pub scrim_open: bool,
}

fn level(open: bool) -> f32 {
    f32::from(u8::from(open))
}

/// `context_key` changed since the last frame: the split places its new state at once.
fn context_changed(shell: &AdaptiveShell, window: &mut Window, cx: &mut App) -> bool {
    let Some(split) = shell.split else {
        return false;
    };
    let seen = window.use_keyed_state((shell.id.clone(), "split-context"), cx, |_, _| {
        split.context_key
    });
    let changed = *seen.read(cx) != split.context_key;
    if changed {
        seen.update(cx, |key, _| *key = split.context_key);
    }
    changed
}

/// A panel's slide on the panel tokens and its reduced-motion fade, each 0 to 1.
fn panel_pair(
    shell: &AdaptiveShell,
    (name, open, jump): (&'static str, bool, bool),
    window: &mut Window,
    cx: &mut App,
) -> (Transition, Transition) {
    let ds = Ds::get(cx);
    let panel = Timing::token(
        ds,
        DsDuration::AdaptivePanelDuration,
        Easing::AdaptivePanelEasing,
    );
    let fade = if open {
        Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard)
    } else {
        Timing::token(ds, DsDuration::MotionExitFast, Easing::MotionEaseStandard)
    };
    let before =
        window.use_keyed_state((shell.id.clone(), format!("{name}-target")), cx, |_, _| {
            open
        });
    if *before.read(cx) != open {
        if !jump {
            window.animate_layout(panel.ms());
        }
        before.update(cx, |value, _| *value = open);
    }
    let slide = transition(
        (shell.id.clone(), name),
        (level(open), jump),
        &panel,
        window,
        cx,
    );
    let faded = transition(
        (shell.id.clone(), SharedString::from(format!("{name}-fade"))),
        (level(open), false),
        &fade,
        window,
        cx,
    );
    (slide, faded)
}

/// The browser pane's progress, and its fade under reduced motion.
fn split_motion(
    shell: &AdaptiveShell,
    jump: bool,
    window: &mut Window,
    cx: &mut App,
) -> Option<SplitMotion> {
    let split = shell.split?;
    let ds = Ds::get(cx);
    let panel = Timing::token(
        ds,
        DsDuration::AdaptivePanelDuration,
        Easing::AdaptivePanelEasing,
    );
    let fade = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard);
    let reduced = ds.reduced_motion();
    let id = &shell.id;
    let progress = transition(
        (id.clone(), "split"),
        (level(split.open), reduced || jump),
        &panel,
        window,
        cx,
    );
    let faded = transition(
        (id.clone(), "split-fade"),
        (level(split.open), jump),
        &fade,
        window,
        cx,
    );
    let before = window.use_keyed_state((id.clone(), "split-target"), cx, |_, _| split.open);
    if *before.read(cx) != split.open {
        if !reduced && !jump {
            window.animate_layout(panel.ms());
        }
        before.update(cx, |value, _| *value = split.open);
    }
    Some(SplitMotion {
        progress: progress.target(),
        fade: faded.target(),
        motion: Some(progress),
        fade_motion: Some(faded),
        open: split.open,
        chat_width: split.chat_width,
    })
}

pub(super) fn tracks(
    shell: &AdaptiveShell,
    facts: &Facts,
    window: &mut Window,
    cx: &mut App,
) -> Tracks {
    let context_changed = context_changed(shell, window, cx);
    let ds = Ds::get(cx);
    let reduced = ds.reduced_motion();
    let animate = !shell.resizing && !shell.settings_active;
    // Reduced motion and (docked) a live resize or the settings screen place a panel at once.
    let jump = reduced || (!facts.drawer && !animate);
    let peek_timing = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard);
    let scrim_timing = Timing::token(
        ds,
        DsDuration::AdaptivePanelDuration,
        Easing::AdaptivePanelEasing,
    );
    let (left, left_fade) = panel_pair(shell, ("left", shell.left_open, jump), window, cx);
    let (right, right_fade) = panel_pair(shell, ("right", facts.inspector_open, jump), window, cx);
    let scrim = transition(
        (shell.id.clone(), "scrim"),
        (level(facts.scrim_open), reduced),
        &scrim_timing,
        window,
        cx,
    );
    let peek = transition(
        (shell.id.clone(), "peek"),
        (level(facts.peeking), false),
        &peek_timing,
        window,
        cx,
    );
    Tracks {
        left,
        left_fade,
        right,
        right_fade,
        scrim,
        peek,
        split: split_motion(shell, context_changed, window, cx),
    }
}
